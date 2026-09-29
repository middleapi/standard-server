import type { StandardBody, StandardBodyHint, StandardHeaders } from '@standard-server/core'
import type { ToEventStreamOptions } from './event-stream'
import type { NodeHttpRequest } from './types'
import { Readable } from 'node:stream'
import { generateContentDisposition, getFilenameFromContentDisposition, resolveStandardBodyHint, StandardBodyTooLargeError } from '@standard-server/core'
import { isAsyncIteratorObject, parseEmptyableJSON, stringifyJSON } from '@standard-server/shared'
import { toAsyncIteratorObject, toEventStream } from './event-stream'
import { cancelNodeReadable, readableChunkToBytes, toWebReadableStream } from './utils'

export interface ToStandardBodyOptions {
  /**
   * Hints on how the body should be parsed.
   */
  hint?: StandardBodyHint | undefined

  /**
   * The maximum size, in bytes, of a body read into memory (`json`, `form-data`,
   * `url-search-params` and `file`). A larger body is rejected with a
   * `StandardBodyTooLargeError`: up front when its `content-length` is already
   * larger, otherwise as soon as the bytes read exceed it. The rest of the body
   * is discarded, so a response can still be sent.
   *
   * Streamed bodies (`event-stream` and `octet-stream`) are not limited,
   * since the application controls how much of them it reads.
   *
   * @default undefined (no limit)
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

  const hint = options?.hint ?? resolveStandardBodyHint({
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

  if (hint === 'json') {
    const text = await _streamToString(_readBody(req, options.maxBodySize))
    return parseEmptyableJSON(text)
  }

  const contentType = req.headers['content-type']

  if (hint === 'form-data') {
    return _streamToFormData(_readBody(req, options.maxBodySize), contentType)
  }

  if (hint === 'url-search-params') {
    const text = await _streamToString(_readBody(req, options.maxBodySize))
    return new URLSearchParams(text)
  }

  if (hint === 'event-stream') {
    return toAsyncIteratorObject(req)
  }

  if (hint === 'file') {
    const contentDisposition = req.headers['content-disposition']
    const fileName = contentDisposition !== undefined
      ? getFilenameFromContentDisposition(contentDisposition)
      : undefined

    return _streamToFile(_readBody(req, options.maxBodySize), fileName ?? 'blob', contentType ?? '')
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
): [
  body: Readable | undefined | string,
  headers: StandardHeaders,
] {
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
    headers['content-disposition'] ??= generateContentDisposition(body instanceof File ? body.name ?? '' : 'blob')

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
 * Reads the chunks of a request body, rejecting with `StandardBodyTooLargeError`
 * once it is known to exceed `maxBodySize`.
 */
async function* _readBody(
  req: NodeHttpRequest,
  maxBodySize: number | undefined,
): AsyncGenerator<Uint8Array<ArrayBuffer>, void, undefined> {
  if (maxBodySize !== undefined && Number(req.headers['content-length']) > maxBodySize) {
    // no reason: nothing listens to the request yet, so its error event would be unhandled
    cancelNodeReadable(req)
    throw new StandardBodyTooLargeError(maxBodySize)
  }

  // Iterate by hand: breaking out of a `for await` would destroy the request
  const iterator = req[Symbol.asyncIterator]()
  let size = 0

  while (true) {
    const { done, value } = await iterator.next()

    if (done) {
      return
    }

    const chunk = readableChunkToBytes(req, value)
    size += chunk.byteLength

    if (maxBodySize !== undefined && size > maxBodySize) {
      const error = new StandardBodyTooLargeError(maxBodySize)
      cancelNodeReadable(req, error, iterator)
      throw error
    }

    yield chunk
  }
}

function _streamToFormData(body: AsyncIterable<Uint8Array<ArrayBuffer>>, contentType: string | undefined): Promise<FormData> {
  const response = new Response(body, {
    headers: {
      'content-type': contentType,
    },
  })

  return response.formData()
}

async function _streamToString(body: AsyncIterable<Uint8Array<ArrayBuffer>>): Promise<string> {
  const decoder = new TextDecoder()
  let string = ''

  for await (const chunk of body) {
    string += decoder.decode(chunk, { stream: true })
  }

  // Flush any remaining bytes (e.g. incomplete multi-byte sequences)
  string += decoder.decode()

  return string
}

async function _streamToFile(body: AsyncIterable<Uint8Array<ArrayBuffer>>, fileName: string, contentType: string): Promise<File> {
  const chunks: Uint8Array<ArrayBuffer>[] = []

  for await (const chunk of body) {
    chunks.push(chunk)
  }

  return new File(chunks, fileName, { type: contentType })
}
