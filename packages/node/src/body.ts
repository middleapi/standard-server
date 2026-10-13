import { Readable } from 'node:stream'

import type { StandardBody, StandardBodyHint, StandardHeaders } from '@standard-server/core'
import {
  generateContentDisposition,
  getFilenameFromContentDisposition,
  resolveStandardBodyHint,
} from '@standard-server/core'
import {
  isAsyncIteratorObject,
  parseEmptyableJSON,
  PayloadTooLargeError,
  stringifyJSON,
} from '@standard-server/shared'

import type { ToEventStreamOptions } from './event-stream'
import { toAsyncIteratorObject, toEventStream } from './event-stream'
import type { NodeHttpRequest } from './types'
import { discardNodeReadable, readableChunkToBytes, toWebReadableStream } from './utils'

export interface ToStandardBodyOptions {
  /**
   * Hints on how the body should be parsed.
   */
  hint?: StandardBodyHint | undefined

  /**
   * The maximum number of bytes read into memory for the `json`, `url-search-params`,
   * `form-data` and `file` hints. A larger body rejects with a `PayloadTooLargeError`
   * (status 413). Streamed hints (`octet-stream`, `event-stream`) are never limited.
   *
   * @default Infinity
   */
  maxBodySize?: number | undefined
}

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

  if (!req.readable) {
    // native fetch error use TypeError
    throw new TypeError('Failed to read body: body stream already read or destroyed')
  }

  const maxBodySize = options.maxBodySize ?? Number.POSITIVE_INFINITY

  if (hint === 'json') {
    const text = await _streamToString(req, maxBodySize)
    return parseEmptyableJSON(text)
  }

  const contentType = req.headers['content-type']

  if (hint === 'form-data') {
    return _streamToFormData(req, contentType, maxBodySize)
  }

  if (hint === 'url-search-params') {
    const text = await _streamToString(req, maxBodySize)
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

    return _streamToFile(req, fileName ?? 'blob', contentType ?? '', maxBodySize)
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
    headers['content-type'] = 'application/x-www-form-urlencoded'
    return [body.toString(), headers]
  }

  if (isAsyncIteratorObject(body)) {
    headers['content-type'] = 'text/event-stream'
    return [toEventStream(body, options.eventStream), headers]
  }

  headers['content-type'] = 'application/json'
  return [stringifyJSON(body), headers]
}

/**
 * Reads a request body chunk by chunk, rejecting with a `PayloadTooLargeError` once it
 * exceeds `maxBodySize`: before any read for a larger `content-length`, otherwise as soon
 * as the bytes read pass it.
 *
 * Pulls through the iterator rather than `for await`, which destroys the stream when left
 * early: destroying an http1 request kills the socket its 413 response needs.
 */
async function* _readBody(
  req: NodeHttpRequest,
  maxBodySize: number,
): AsyncGenerator<Uint8Array<ArrayBuffer>, void, undefined> {
  if (Number(req.headers['content-length']) > maxBodySize) {
    throw _payloadTooLarge(maxBodySize)
  }

  const iterator = req[Symbol.asyncIterator]()
  let size = 0

  while (true) {
    const { done, value } = await iterator.next()

    if (done) {
      return
    }

    const bytes = readableChunkToBytes(req, value)
    size += bytes.byteLength

    if (size > maxBodySize) {
      const error = _payloadTooLarge(maxBodySize)
      discardNodeReadable(req, iterator, error)
      throw error
    }

    yield bytes
  }
}

function _payloadTooLarge(maxBodySize: number): PayloadTooLargeError {
  return new PayloadTooLargeError(`Body exceeds the size limit of ${maxBodySize} bytes`)
}

function _streamToFormData(
  req: NodeHttpRequest,
  contentType: string | undefined,
  maxBodySize: number,
): Promise<FormData> {
  const chunks = _readBody(req, maxBodySize)

  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const { done, value } = await chunks.next()

      if (done) {
        controller.close()
      } else {
        controller.enqueue(value)
      }
    },
  })

  const response = new Response(body, {
    headers: {
      'content-type': contentType ?? '',
    },
  })

  return response.formData()
}

async function _streamToString(req: NodeHttpRequest, maxBodySize: number): Promise<string> {
  const decoder = new TextDecoder()
  let string = ''

  for await (const bytes of _readBody(req, maxBodySize)) {
    string += decoder.decode(bytes, { stream: true })
  }

  // Flush any remaining bytes (e.g. incomplete multi-byte sequences)
  string += decoder.decode()

  return string
}

async function _streamToFile(
  req: NodeHttpRequest,
  fileName: string,
  contentType: string,
  maxBodySize: number,
): Promise<File> {
  const chunks: Uint8Array<ArrayBuffer>[] = []

  for await (const bytes of _readBody(req, maxBodySize)) {
    chunks.push(bytes)
  }

  return new File(chunks, fileName, { type: contentType })
}
