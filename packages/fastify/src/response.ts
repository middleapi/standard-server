import type { StandardHeaders, StandardResponse } from '@standard-server/core'
import type { ToNodeHttpBodyOptions } from '@standard-server/node'
import {
  canWriteToNodeResponse,
  destroyNodeHttpBody,
  getNodeResponseError,
  toNodeHttpBody,
} from '@standard-server/node'

import type { AnyFastifyReply } from './types'

export interface SendStandardResponseOptions extends ToNodeHttpBodyOptions {}

export async function sendStandardResponse(
  reply: AnyFastifyReply,
  standardResponse: StandardResponse,
  options: SendStandardResponseOptions = {},
): Promise<void> {
  const [resBody, resHeaders] = toNodeHttpBody(
    standardResponse.body,
    standardResponse.headers,
    options,
  )

  return new Promise((resolve, reject) => {
    if (!canWriteToNodeResponse(reply.raw)) {
      const error = getNodeResponseError(reply.raw)

      destroyNodeHttpBody(resBody, error, reject)

      if (error) {
        reject(error)
      } else {
        resolve()
      }

      return
    }

    const connection = 'stream' in reply.raw ? reply.raw.stream : reply.raw

    connection.once('error', reject)
    connection.once('close', () => {
      if (typeof resBody === 'object' && !resBody.closed) {
        resBody.destroy()
      }

      resolve()
    })

    try {
      // Before `reply.status` and `reply.header`: a throw then leaves the reply untouched,
      // so fastify's error handler can still send a clean 500
      const headers = toFastifyHeaders(resHeaders, 'stream' in reply.raw)

      reply.status(standardResponse.status)

      for (const key of Object.keys(headers)) {
        reply.header(key, headers[key])
      }

      // fastify pipes the stream body itself, no manual piping needed
      reply.send(resBody)
    } catch (error) {
      destroyNodeHttpBody(resBody, error, reject)

      // Don't destroy reply.raw: fastify's error handler can still send a response.
      reject(error)
    }
  })
}

/**
 * HTTP/2 connection-specific fields (RFC 9113, section 8.2.2), apart from `connection`,
 * which Node drops with a warning, and `te`, which is allowed as `trailers`.
 */
const HTTP2_CONNECTION_SPECIFIC_HEADERS = new Set([
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
])

/**
 * Reject the headers Node only rejects once fastify commits the head: with a stream
 * body that happens inside fastify's pipe, out of the adapter's reach, and otherwise
 * fastify's error handler resends the stored headers and throws again.
 */
function toFastifyHeaders(
  standardHeaders: StandardHeaders,
  isHttp2: boolean,
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}

  for (const key of Object.keys(standardHeaders)) {
    let value = standardHeaders[key]

    // DON'T pass headers with `undefined` value to fastify, it turns them into empty strings
    if (value === undefined) {
      continue
    }

    // An empty array removes the header, there is nothing to send or check
    if (Array.isArray(value) && value.length === 0) {
      headers[key] = value
      continue
    }

    const name = key.toLowerCase()

    // Node rejects it whenever the response isn't chunked, which depends on the request
    if (name === 'trailer') {
      throw new TypeError('Invalid header "trailer": a StandardResponse cannot carry trailers')
    }

    // Join multi-value headers into one field line, as HTTP/2 rejects repeated values
    // for single-value fields. `set-cookie` values can't be joined without corrupting them.
    if (Array.isArray(value) && name !== 'set-cookie') {
      value = value.join(', ')
    }

    if (
      isHttp2 &&
      (HTTP2_CONNECTION_SPECIFIC_HEADERS.has(name) || (name === 'te' && value !== 'trailers'))
    ) {
      throw new TypeError(`Invalid header "${name}": HTTP/2 forbids connection-specific headers`)
    }

    headers[key] = value
  }

  return headers
}
