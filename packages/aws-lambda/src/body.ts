import type { StandardBody, StandardBodyHint } from '@standard-server/core'
import type { AnyAPIGatewayProxyEvent } from './types'
import { Buffer } from 'node:buffer'
import { flattenStandardHeader, getFilenameFromContentDisposition, resolveStandardBodyHint } from '@standard-server/core'
import { toAsyncIteratorObject } from '@standard-server/fetch'
import { parseEmptyableJSON } from '@standard-server/shared'
import { getEventHeader } from './headers'

export interface ToStandardBodyOptions {
  /**
   * Hints on how the body should be parsed.
   */
  hint?: StandardBodyHint | undefined
}

/**
 * Parses the fully buffered, optionally base64-encoded body of an API Gateway proxy event.
 */
export async function toStandardBody(
  event: AnyAPIGatewayProxyEvent,
  options: ToStandardBodyOptions = {},
): Promise<StandardBody> {
  const hint = options?.hint ?? resolveStandardBodyHint({
    'standard-server': getEventHeader(event, 'standard-server'),
    'content-type': getEventHeader(event, 'content-type'),
    'content-length': getEventHeader(event, 'content-length'),
    'content-disposition': getEventHeader(event, 'content-disposition'),
  })

  if (hint === 'none') {
    return undefined
  }

  const bytes: Uint8Array<ArrayBuffer> = typeof event.body !== 'string'
    ? new Uint8Array()
    : event.isBase64Encoded
      ? new Uint8Array(Buffer.from(event.body, 'base64'))
      : new TextEncoder().encode(event.body)

  if (hint === 'json') {
    return parseEmptyableJSON(new TextDecoder().decode(bytes))
  }

  const contentType = flattenStandardHeader(getEventHeader(event, 'content-type'))

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
    const contentDisposition = flattenStandardHeader(getEventHeader(event, 'content-disposition'))
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
