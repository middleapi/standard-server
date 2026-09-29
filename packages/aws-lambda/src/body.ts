import type { StandardBody, StandardBodyHint } from '@standard-server/core'
import type { AnyAPIGatewayProxyEvent } from './types'
import { Buffer } from 'node:buffer'
import { flattenStandardHeader, getFilenameFromContentDisposition, resolveStandardBodyHint, StandardBodyTooLargeError } from '@standard-server/core'
import { toAsyncIteratorObject } from '@standard-server/fetch'
import { parseEmptyableJSON } from '@standard-server/shared'
import { toStandardHeaders } from './headers'

export interface ToStandardBodyOptions {
  /**
   * Hints on how the body should be parsed.
   */
  hint?: StandardBodyHint | undefined

  /**
   * The maximum size, in bytes, of a body parsed as `json`, `form-data`,
   * `url-search-params` or `file`. A larger body is rejected with a
   * `StandardBodyTooLargeError` before it is parsed. Lambda has already
   * buffered the whole body, so this bounds the parsing, not the payload
   * Lambda accepts.
   *
   * `event-stream` and `octet-stream` bodies are not limited,
   * like in the other adapters.
   *
   * @default undefined (no limit)
   */
  maxBodySize?: number | undefined
}

/**
 * Parses the fully buffered, optionally base64-encoded body of an API Gateway proxy event.
 */
export async function toStandardBody(
  event: AnyAPIGatewayProxyEvent,
  options: ToStandardBodyOptions = {},
): Promise<StandardBody> {
  const headers = toStandardHeaders(event)
  const hint = options.hint ?? resolveStandardBodyHint(headers)

  if (hint === 'none') {
    return undefined
  }

  const bytes: Uint8Array<ArrayBuffer> = typeof event.body !== 'string'
    ? new Uint8Array()
    : event.isBase64Encoded
      ? new Uint8Array(Buffer.from(event.body, 'base64'))
      : new TextEncoder().encode(event.body)

  if (
    options.maxBodySize !== undefined
    && bytes.byteLength > options.maxBodySize
    && hint !== 'event-stream'
    && hint !== 'octet-stream'
  ) {
    throw new StandardBodyTooLargeError(options.maxBodySize)
  }

  if (hint === 'json') {
    return parseEmptyableJSON(new TextDecoder().decode(bytes))
  }

  const contentType = flattenStandardHeader(headers['content-type'])

  if (hint === 'form-data') {
    return _bytesToFormData(bytes, contentType)
  }

  if (hint === 'url-search-params') {
    return new URLSearchParams(new TextDecoder().decode(bytes))
  }

  if (hint === 'event-stream') {
    return toAsyncIteratorObject(_bytesToReadableStream(bytes))
  }

  if (hint === 'file') {
    const contentDisposition = flattenStandardHeader(headers['content-disposition'])
    const fileName = contentDisposition !== undefined
      ? getFilenameFromContentDisposition(contentDisposition)
      : undefined

    return new File([bytes], fileName ?? 'blob', { type: contentType ?? '' })
  }

  return _bytesToReadableStream(bytes)
}

function _bytesToFormData(bytes: Uint8Array<ArrayBuffer>, contentType: string | undefined): Promise<FormData> {
  const response = new Response(bytes, {
    headers: {
      'content-type': contentType ?? '',
    },
  })

  return response.formData()
}

function _bytesToReadableStream(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
