import { Readable } from 'node:stream'

import type { StandardBody, StandardBodyHint, StandardHeaders } from '@standard-server/core'
import {
  generateContentDisposition,
  getFilenameFromContentDisposition,
  getRequiredStandardBodyHint,
  resolveStandardBodyHint,
} from '@standard-server/core'
import { isAsyncIteratorObject, parseEmptyableJSON, stringifyJSON } from '@standard-server/shared'

import type { ToEventStreamOptions } from './event-stream'
import { toAsyncIteratorObject, toEventStream } from './event-stream'
import type { NodeHttpRequest } from './types'
import { readableChunkToBytes, toWebReadableStream } from './utils'

export interface ToStandardBodyOptions {
  /**
   * Hints on how the body should be parsed.
   */
  hint?: StandardBodyHint | undefined
}

/**
 * Requests whose body stream a parser has already been attached to.
 */
const consumedRequests = new WeakSet<NodeHttpRequest>()

/**
 * Parses the body of a node http request.
 */
export async function toStandardBody(
  req: NodeHttpRequest,
  options: ToStandardBodyOptions = {},
): Promise<StandardBody> {
  // body's already parsed by upstream framework like express, ...
  if (req.body !== undefined && !req.readable) {
    return req.body
  }

  const hint =
    options?.hint ??
    resolveStandardBodyHint({
      'standard-server': req.headers['standard-server'],
      'content-type': req.headers['content-type'],
      'content-length': req.headers['content-length'],
      'content-disposition': req.headers['content-disposition'],
    })

  if (hint === 'none') {
    return undefined
  }

  // `readable` stays true until the stream ends, so it misses overlapping or lazy
  // (stream/iterator) reads; mark the request before the first await to catch those.
  if (!req.readable || consumedRequests.has(req)) {
    // native fetch error use TypeError
    throw new TypeError('Failed to read body: body stream already read or destroyed')
  }

  consumedRequests.add(req)

  if (hint === 'json') {
    const text = await _streamToString(req)
    return parseEmptyableJSON(text)
  }

  const contentType = req.headers['content-type']

  if (hint === 'form-data') {
    return _streamToFormData(req, contentType)
  }

  if (hint === 'url-search-params') {
    const text = await _streamToString(req)
    return new URLSearchParams(text)
  }

  if (hint === 'event-stream') {
    return toAsyncIteratorObject(req)
  }

  if (hint === 'file') {
    const contentDisposition = req.headers['content-disposition']
    const fileName =
      contentDisposition !== undefined
        ? getFilenameFromContentDisposition(contentDisposition)
        : undefined

    return _streamToFile(req, fileName ?? 'blob', contentType ?? '')
  }

  return toWebReadableStream(req)
}

export interface ToNodeHttpBodyOptions {
  /**
   * Options for the event stream, like keep-alive settings, initial comment, etc.
   */
  eventStream?: ToEventStreamOptions
}

/**
 * Convert a standard body to a node http body.
 *
 * Binary bodies (Blob, ReadableStream) can override the aut-set standard-server header,
 * enabling pre-encoded body transmission while preserving client-side type interpretation.
 */
export function toNodeHttpBody(
  body: StandardBody,
  headers: StandardHeaders,
  options: ToNodeHttpBodyOptions = {},
): [body: Readable | undefined | string, headers: StandardHeaders] {
  headers = { ...headers }

  if (body instanceof ReadableStream) {
    // Always set the body hint: the length of a stream is unknown here, but the transport
    // can still send a content-length (an empty stream), which reads back as a file.
    headers['standard-server'] ??= 'octet-stream' satisfies StandardBodyHint

    // content-type is required when body is present
    headers['content-type'] ??= 'application/octet-stream'

    return [Readable.fromWeb(body), headers]
  }

  if (body instanceof Blob) {
    // Explicitly set the body hint: the content headers alone cannot always identify a file,
    // and a transport can drop the empty ones (bun) or a proxy rewrite the content-length.
    headers['standard-server'] ??= 'file' satisfies StandardBodyHint // A File is also a Blob

    headers['content-type'] ??= body.type
    // FIX: Bun returns `undefined` for an empty File name, despite the spec requiring a string
    headers['content-disposition'] ??= generateContentDisposition(
      body instanceof File ? (body.name ?? '') : 'blob',
    )

    // BunS3 can use NaN for the size
    if (Number.isFinite(body.size)) {
      headers['content-length'] = body.size.toString()
    }

    return [Readable.fromWeb(body.stream()), headers]
  }

  headers['standard-server'] = undefined
  headers['content-length'] = undefined

  // An empty body has no media type, so unlike the bodies below it drops a given content-type
  if (body === undefined) {
    headers['content-type'] = undefined
    return [undefined, headers]
  }

  if (body instanceof FormData) {
    const response = new Response(body)
    headers['content-type'] = response.headers.get('content-type')!
    return [Readable.fromWeb(response.body!), headers]
  }

  if (body instanceof URLSearchParams) {
    headers['content-type'] ??= 'application/x-www-form-urlencoded'
    headers['standard-server'] = getRequiredStandardBodyHint('url-search-params', headers)
    return [body.toString(), headers]
  }

  if (isAsyncIteratorObject(body)) {
    headers['content-type'] ??= 'text/event-stream'
    headers['standard-server'] = getRequiredStandardBodyHint('event-stream', headers)
    return [toEventStream(body, options.eventStream), headers]
  }

  headers['content-type'] ??= 'application/json'
  headers['standard-server'] = getRequiredStandardBodyHint('json', headers)
  return [stringifyJSON(body), headers]
}

function _streamToFormData(stream: Readable, contentType: string | undefined): Promise<FormData> {
  const response = new Response(toWebReadableStream(stream), {
    headers: {
      'content-type': contentType ?? '',
    },
  })

  return response.formData()
}

async function _streamToString(stream: Readable): Promise<string> {
  const decoder = new TextDecoder()
  let string = ''

  for await (const chunk of stream) {
    string += decoder.decode(readableChunkToBytes(stream, chunk), { stream: true })
  }

  // Flush any remaining bytes (e.g. incomplete multi-byte sequences)
  string += decoder.decode()

  return string
}

async function _streamToFile(
  stream: Readable,
  fileName: string,
  contentType: string,
): Promise<File> {
  const chunks: Uint8Array<ArrayBuffer>[] = []

  for await (const chunk of stream) {
    chunks.push(readableChunkToBytes(stream, chunk))
  }

  return new File(chunks, fileName, { type: contentType })
}
