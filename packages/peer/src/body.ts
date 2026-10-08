import type { StandardBody, StandardBodyHint, StandardHeaders } from '@standard-server/core'
import {
  flattenStandardHeader,
  generateContentDisposition,
  getFilenameFromContentDisposition,
} from '@standard-server/core'
import type { AsyncCleanupFn } from '@standard-server/shared'
import { isAsyncIteratorObject, Queue } from '@standard-server/shared'

import { toAsyncIteratorObject } from './event-stream'
import { toOctetStream } from './octet-stream'
import type {
  PeerEventStreamMessage,
  PeerOctetStreamMessage,
  PeerRequestMessage,
  PeerResponseMessage,
} from './types'

export interface ToStandardBodyResult {
  resolveBody: () => Promise<StandardBody>
  eventStreamMessageQueue?: Queue<PeerEventStreamMessage>
  octetStreamMessageQueue?: Queue<PeerOctetStreamMessage>
}

/**
 * Parse a peer message body.
 */
export function toStandardBody(
  message: PeerRequestMessage | PeerResponseMessage,
  cleanup: AsyncCleanupFn,
): ToStandardBodyResult {
  const rawContentType = message.json.headers?.['content-type']
  const contentType = flattenStandardHeader(rawContentType)
  const bodyHint = flattenStandardHeader(message.json.headers?.['standard-server'])

  if (message.json.body === undefined && message.binary === undefined) {
    // Check the raw header: a stream sent with `content-type: []` has no content-type once flattened
    if (rawContentType === undefined && bodyHint === ('event-stream' satisfies StandardBodyHint)) {
      const eventStreamMessageQueue = new Queue<PeerEventStreamMessage>()
      return {
        resolveBody: resolveStreamBodyOnce(() =>
          toAsyncIteratorObject(eventStreamMessageQueue, cleanup),
        ),
        eventStreamMessageQueue,
      }
    }

    if (rawContentType !== undefined) {
      const octetStreamMessageQueue = new Queue<PeerOctetStreamMessage>()
      return {
        resolveBody: resolveStreamBodyOnce(() => toOctetStream(octetStreamMessageQueue, cleanup)),
        octetStreamMessageQueue,
      }
    }
  }

  const resolveBody = async () => {
    let errorRef: { value: unknown } | undefined

    try {
      if (message.binary) {
        if (bodyHint === ('form-data' satisfies StandardBodyHint)) {
          const headers: { 'content-type'?: string } = {}

          if (contentType !== undefined) {
            headers['content-type'] = contentType
          }

          const res = new Response(message.binary, {
            headers,
          })

          const form = await res.formData()
          return form
        }

        const contentDisposition = flattenStandardHeader(
          message.json.headers?.['content-disposition'],
        )
        const filename =
          contentDisposition !== undefined
            ? getFilenameFromContentDisposition(contentDisposition)
            : undefined

        const file = new File([message.binary], filename ?? 'blob', {
          type: contentType ?? 'application/octet-stream',
        })
        return file
      }

      if (bodyHint === ('url-search-params' satisfies StandardBodyHint)) {
        if (typeof message.json.body !== 'string') {
          throw new TypeError('Expected body to be a string for url-search-params bodyHint')
        }

        return new URLSearchParams(message.json.body)
      }

      return message.json.body // undefined | json body
    } catch (error) {
      errorRef = { value: error }
      throw error
    } finally {
      // The body is fully loaded, so we can clean up immediately.
      await cleanup(errorRef ? { kind: 'error', error: errorRef.value } : { kind: 'success' })
    }
  }

  return { resolveBody }
}

/**
 * A streamed body has a single queue, so a second consumer would split its messages
 * with the first one. Like the fetch and node adapters, reject reading it more than once.
 */
function resolveStreamBodyOnce(resolve: () => StandardBody): () => Promise<StandardBody> {
  let resolved = false

  return async () => {
    if (resolved) {
      // native fetch error use TypeError
      throw new TypeError('Failed to read body: body stream already read')
    }

    resolved = true
    return resolve()
  }
}

export interface EncodedAtomicStandardBody {
  jsonBody: unknown
  headers: StandardHeaders
  binary: Uint8Array<ArrayBuffer> | Blob | undefined
}

/**
 * Encode a `StandardBody` into JSON, binary data, and headers.
 * Event and octet streams are streamed separately.
 *
 * Unlike HTTP adapter, peer adapter has parsed `message.json.body` and `message.binary`
 * so they way it use `standard-server` header to indicate how the body is sent is different.
 *
 * In sematic "content-type" only need to set when transfering binary data.
 */
export async function encodeAtomicStandardBody(
  body: StandardBody,
  headers: StandardHeaders,
): Promise<EncodedAtomicStandardBody> {
  headers = { ...headers }

  if (body instanceof ReadableStream) {
    headers['content-type'] ??= 'application/octet-stream'
    return { jsonBody: undefined, headers, binary: undefined }
  }

  if (body instanceof Blob) {
    headers['content-type'] ??= body.type
    // FIX: Bun returns `undefined` for an empty File name, despite the spec requiring a string
    headers['content-disposition'] ??= generateContentDisposition(
      body instanceof File ? (body.name ?? '') : 'blob',
    )

    // BunS3 can use NaN for the size
    if (Number.isFinite(body.size)) {
      headers['content-length'] = body.size.toString()
    }

    return { jsonBody: undefined, headers, binary: body }
  }

  headers['standard-server'] = undefined
  headers['content-type'] = undefined

  if (isAsyncIteratorObject(body)) {
    // standard-server used to distinguish vs. undefined
    headers['standard-server'] = 'event-stream' satisfies StandardBodyHint
    return { jsonBody: undefined, headers, binary: undefined }
  }

  if (body instanceof FormData) {
    const res = new Response(body)
    const blob = await res.blob()

    // standard-server used to distinguish file vs. form-data
    headers['standard-server'] = 'form-data' satisfies StandardBodyHint
    headers['content-type'] = blob.type
    headers['content-length'] = blob.size.toString()

    return { jsonBody: undefined, headers, binary: blob }
  }

  if (body instanceof URLSearchParams) {
    // standard-server used to distinguish url-search-params vs. undefined | json
    headers['standard-server'] = 'url-search-params' satisfies StandardBodyHint
    return { jsonBody: body.toString(), headers, binary: undefined }
  }

  return { jsonBody: body, headers, binary: undefined }
}
