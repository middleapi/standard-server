import type { StandardBody, StandardBodyHint, StandardHeaders } from '@standard-server/core'
import type { ToEventStreamOptions } from './event-stream'
import { generateContentDisposition, getFilenameFromContentDisposition, resolveStandardBodyHint, StandardBodyTooLargeError } from '@standard-server/core'
import { isAsyncIteratorObject, parseEmptyableJSON, stringifyJSON } from '@standard-server/shared'
import { toAsyncIteratorObject, toEventStream } from './event-stream'

export interface ToStandardBodyOptions {
  /**
   * Hints on how the body should be parsed.
   */
  hint?: StandardBodyHint | undefined

  /**
   * The maximum size, in bytes, of a body read into memory (`json`, `form-data`,
   * `url-search-params` and `file`). A larger body is rejected with a
   * `StandardBodyTooLargeError`: up front when its `content-length` is already
   * larger, otherwise as soon as the bytes read exceed it, cancelling the rest.
   *
   * Streamed bodies (`event-stream` and `octet-stream`) are not limited,
   * since the application controls how much of them it reads.
   *
   * @default undefined (no limit)
   */
  maxBodySize?: number | undefined
}

/**
 * Convert a fetch request or response to a standard body.
 */
export async function toStandardBody(re: Request | Response, options?: ToStandardBodyOptions): Promise<StandardBody> {
  const hint = options?.hint ?? resolveStandardBodyHint({
    'standard-server': re.headers.get('standard-server') ?? undefined,
    'content-type': re.headers.get('content-type') ?? undefined,
    'content-length': re.headers.get('content-length') ?? undefined,
    'content-disposition': re.headers.get('content-disposition') ?? undefined,
  })

  if (hint === 'none') {
    return undefined
  }

  if (re.bodyUsed) {
    // native fetch error use TypeError
    throw new TypeError('Failed to read body: body stream already read')
  }

  if (hint === 'json') {
    const text = await _limitBody(re, options?.maxBodySize).text()
    return parseEmptyableJSON(text)
  }

  if (hint === 'form-data') {
    return await _limitBody(re, options?.maxBodySize).formData()
  }

  if (hint === 'url-search-params') {
    const text = await _limitBody(re, options?.maxBodySize).text()
    return new URLSearchParams(text)
  }

  if (hint === 'event-stream') {
    return toAsyncIteratorObject(re.body)
  }

  if (hint === 'file') {
    const contentDisposition = re.headers.get('content-disposition')
    const fileName = contentDisposition !== null
      ? getFilenameFromContentDisposition(contentDisposition)
      : undefined

    const blob = await _limitBody(re, options?.maxBodySize).blob()
    return new File([blob], fileName ?? 'blob', {
      type: blob.type,
    })
  }

  return re.body ?? new ReadableStream({
    start(controller) {
      controller.close()
    },
  })
}

/**
 * Limits the body to `maxBodySize` bytes: reading the returned body rejects with
 * `StandardBodyTooLargeError` once the body is known to exceed it.
 */
function _limitBody(re: Request | Response, maxBodySize: number | undefined): Request | Response {
  if (maxBodySize === undefined || re.body === null) {
    return re
  }

  if (Number(re.headers.get('content-length')) > maxBodySize) {
    const error = new StandardBodyTooLargeError(maxBodySize)

    // Leave an unread request body to the server, which discards it like any unread body,
    // while cancelling one can stall the next keep-alive request (e.g. srvx on Node).
    // An unread response body would hold its connection instead.
    if (re instanceof Response) {
      re.body.cancel(error).catch(() => {})
    }

    throw error
  }

  let size = 0

  // throwing errors the piped stream and cancels the source body with the error
  const body = re.body.pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      size += chunk.byteLength

      if (size > maxBodySize) {
        throw new StandardBodyTooLargeError(maxBodySize)
      }

      controller.enqueue(chunk)
    },
  }))

  // read through a Response, so the limited body parses exactly like the original
  const contentType = re.headers.get('content-type')

  return new Response(body, {
    headers: contentType === null ? {} : { 'content-type': contentType },
  })
}

export interface ToFetchBodyOptions {
  /**
   * Options for the event stream, like keep-alive settings, initial comment, etc.
   */
  eventStream?: ToEventStreamOptions
}

/**
 * Convert a standard body to a fetch body.
 *
 * Binary bodies (Blob, ReadableStream) can override the aut-set standard-server header,
 * enabling pre-encoded body transmission while preserving client-side type interpretation.
 */
export function toFetchBody(
  body: StandardBody,
  headers: StandardHeaders,
  options: ToFetchBodyOptions = {},
): [
  body: undefined | string | FormData | URLSearchParams | Blob | ReadableStream<Uint8Array<ArrayBuffer>>,
  headers: StandardHeaders,
] {
  headers = { ...headers }

  if (body instanceof ReadableStream) {
    // Always set the body hint: the length of a stream is unknown here, but the transport
    // can still send a content-length (an empty stream), which reads back as a file.
    headers['standard-server'] ??= 'octet-stream' satisfies StandardBodyHint
    // content-type should be set when body is present
    headers['content-type'] ??= 'application/octet-stream'

    return [body, headers]
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
      return [body, headers]
    }

    return [body.stream(), headers]
  }

  headers['standard-server'] = undefined
  headers['content-length'] = undefined

  if (body === undefined) {
    headers['content-type'] = undefined
    return [undefined, headers]
  }

  if (body instanceof FormData) {
    // Fetch automatically sets content-type for FormData bodies.
    headers['content-type'] = undefined
    return [body, headers]
  }

  if (body instanceof URLSearchParams) {
    // Fetch automatically sets content-type for URLSearchParams bodies.
    headers['content-type'] = undefined
    return [body, headers]
  }

  if (isAsyncIteratorObject(body)) {
    headers['content-type'] = 'text/event-stream'
    return [toEventStream(body, options.eventStream), headers]
  }

  headers['content-type'] = 'application/json'
  return [stringifyJSON(body), headers]
}
