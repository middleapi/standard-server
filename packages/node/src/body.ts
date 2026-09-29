import type { StandardBody, StandardBodyHint, StandardHeaders } from '@standard-server/core'
import type { ToEventStreamOptions } from './event-stream'
import type { NodeHttpRequest } from './types'
import { Buffer } from 'node:buffer'
import { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { generateContentDisposition, getFilenameFromContentDisposition, resolveStandardBodyHint } from '@standard-server/core'
import { isAsyncIteratorObject, parseEmptyableJSON, stringifyJSON } from '@standard-server/shared'
import { toAsyncIteratorObject, toEventStream } from './event-stream'
import { toWebReadableStream } from './utils'

export interface ToStandardBodyOptions {
  /**
   * Hints on how the body should be parsed.
   */
  hint?: StandardBodyHint | undefined
}

/**
 * Parses the body of a node http request.
 */
export async function toStandardBody(
  req: NodeHttpRequest,
  options: ToStandardBodyOptions = {},
): Promise<StandardBody> {
  // `req.body` and `req.rawBody` are only trusted once the stream was consumed (an empty body ends it
  // without a read): body-parser 1.x (express 4) assigns `{}` to requests it leaves unread,
  // and a destroyed request is not readable either
  const consumed = !req.readable && (req.readableDidRead || req.readableEnded)

  // Some platforms (e.g. Firebase and Google Cloud Functions) consume the stream before
  // the handler runs and keep the unparsed bytes, while `req.body` is only parsed for some types
  const rawBody = consumed && req.rawBody instanceof Uint8Array ? req.rawBody : undefined

  // body's already parsed by upstream framework like express, ...
  if (consumed && rawBody === undefined && req.body !== undefined) {
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

  let stream: Readable = req

  if (!req.readable) {
    const buffered = rawBody ?? _readBodyBufferedBeforeDisconnect(req)

    if (buffered === undefined) {
      // native fetch error use TypeError
      throw new TypeError('Failed to read body: body stream already read or destroyed')
    }

    stream = Readable.from([buffered])
  }

  if (hint === 'json') {
    const text = await _streamToString(stream)
    return parseEmptyableJSON(text)
  }

  const contentType = req.headers['content-type']

  if (hint === 'form-data') {
    return _streamToFormData(stream, contentType)
  }

  if (hint === 'url-search-params') {
    const text = await _streamToString(stream)
    return new URLSearchParams(text)
  }

  if (hint === 'event-stream') {
    return toAsyncIteratorObject(stream)
  }

  if (hint === 'file') {
    const contentDisposition = req.headers['content-disposition']
    const fileName = contentDisposition !== undefined
      ? getFilenameFromContentDisposition(contentDisposition)
      : undefined

    return _streamToFile(stream, fileName ?? 'blob', contentType ?? '')
  }

  return toWebReadableStream(stream)
}

const RECOVERED_REQUESTS = new WeakSet<IncomingMessage>()

/**
 * A client can disconnect after node parsed its whole http1 request, but before the handler
 * reads the body: node then destroys the request, with the unread body still buffered in it.
 * Returns that body once, or `undefined` when it cannot be recovered.
 *
 * http2 is left out: a stream reset discards the buffered data, and `complete` is not reliable there.
 */
function _readBodyBufferedBeforeDisconnect(req: NodeHttpRequest): Uint8Array | undefined {
  if (
    !(req instanceof IncomingMessage)
    || !req.complete
    || !req.readableAborted
    || req.readableDidRead
    // any other error (e.g. a body size guard destroying the request) must surface
    || (req.errored as NodeJS.ErrnoException | null)?.code !== 'ECONNRESET'
    || RECOVERED_REQUESTS.has(req)
  ) {
    return undefined
  }

  RECOVERED_REQUESTS.add(req)

  const chunk: Buffer<ArrayBuffer> | string | null = req.read()
  const body = chunk === null ? new Uint8Array() : _toBytes(chunk, req.readableEncoding)

  // `read()` on a destroyed stream does not flag it as read, so something
  // may have taken part of the body without `readableDidRead` noticing
  const contentLength = req.headers['content-length']
  if (contentLength !== undefined && /^\d+$/.test(contentLength) && Number(contentLength) !== body.length) {
    return undefined
  }

  return body
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

    // BunS3 can use NaN for the size, and a content-length must not
    // be sent alongside a transfer-encoding (RFC 9112 §6.2)
    if (Number.isFinite(body.size) && headers['transfer-encoding'] === undefined) {
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

function _streamToFormData(stream: Readable, contentType: string | undefined): Promise<FormData> {
  const response = new Response(toWebReadableStream(stream), {
    headers: {
      'content-type': contentType,
    },
  })

  return response.formData()
}

async function _streamToString(stream: Readable): Promise<string> {
  const decoder = new TextDecoder()
  let string = ''

  for await (const chunk of stream) {
    string += decoder.decode(_toBytes(chunk, stream.readableEncoding), { stream: true })
  }

  // Flush any remaining bytes (e.g. incomplete multi-byte sequences)
  string += decoder.decode()

  return string
}

async function _streamToFile(stream: Readable, fileName: string, contentType: string): Promise<File> {
  const chunks: Uint8Array<ArrayBuffer>[] = []

  for await (const chunk of stream) {
    chunks.push(_toBytes(chunk, stream.readableEncoding))
  }

  return new File(chunks, fileName, { type: contentType })
}

/**
 * Node yields strings instead of bytes once `setEncoding()` is called on a stream,
 * encoding them back with the same encoding recovers the original bytes.
 */
function _toBytes(chunk: Uint8Array<ArrayBuffer> | string, encoding: BufferEncoding | null): Uint8Array<ArrayBuffer> {
  return typeof chunk === 'string' ? Buffer.from(chunk, encoding ?? 'utf8') : chunk
}
