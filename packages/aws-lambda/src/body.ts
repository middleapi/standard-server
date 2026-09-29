/// <reference lib="es2024.string" />

import type { StandardBody, StandardBodyHint } from '@standard-server/core'
import type { AnyAPIGatewayProxyEvent } from './types'
import { Buffer } from 'node:buffer'
import { flattenStandardHeader, getFilenameFromContentDisposition, resolveStandardBodyHint } from '@standard-server/core'
import { toAsyncIteratorObject } from '@standard-server/fetch'
import { parseEmptyableJSON } from '@standard-server/shared'
import { toStandardHeaders } from './headers'

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
  const headers = toStandardHeaders(event)
  const hint = options.hint ?? resolveStandardBodyHint(headers)

  if (hint === 'none') {
    return undefined
  }

  if (hint === 'json') {
    return parseEmptyableJSON(_eventBodyToString(event))
  }

  if (hint === 'url-search-params') {
    return new URLSearchParams(_eventBodyToString(event))
  }

  const bytes: Uint8Array<ArrayBuffer> = typeof event.body !== 'string'
    ? new Uint8Array()
    : event.isBase64Encoded
      // copy out of Node's shared Buffer pool so `.buffer` exposes only this body
      ? new Uint8Array(Buffer.from(event.body, 'base64'))
      : new TextEncoder().encode(event.body)

  const contentType = flattenStandardHeader(headers['content-type'])

  if (hint === 'form-data') {
    return _bytesToFormData(bytes, contentType)
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

/**
 * Decodes the body as `TextDecoder` would decode its UTF-8 bytes, without materializing
 * them for a plain body: lone surrogates become U+FFFD and a leading BOM is stripped.
 */
function _eventBodyToString(event: AnyAPIGatewayProxyEvent): string {
  if (typeof event.body !== 'string') {
    return ''
  }

  if (event.isBase64Encoded) {
    return new TextDecoder().decode(Buffer.from(event.body, 'base64'))
  }

  // one-byte strings cannot hold surrogates, so this returns them without scanning
  const string = event.body.toWellFormed()

  return string.charCodeAt(0) === 0xFEFF ? string.slice(1) : string
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
