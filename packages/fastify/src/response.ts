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
      reply.status(standardResponse.status)

      // DON'T pass headers with `undefined` value to fastify, it turns them into empty strings
      for (const key of Object.keys(resHeaders)) {
        const value = resHeaders[key]
        if (value !== undefined) {
          reply.header(key, value)
        }
      }

      // When sending fails before the first byte (the body stream erroring, an `onSend` hook throwing,
      // ...), fastify sends an error payload on this same reply instead, which must not keep the
      // headers describing the body. Install before sending: a sync failure re-enters `reply.send`.
      const send = reply.send
      reply.send = (payload) => {
        reply.send = send
        removeBodyHeaders(reply, resHeaders)
        return send.call(reply, payload)
      }

      // fastify pipes the stream body itself, no manual piping needed
      send.call(reply, resBody)
    } catch (error) {
      destroyNodeHttpBody(resBody, error, reject)

      // Don't destroy reply.raw: fastify's error handler can still send a response.
      reject(error)
    }
  })
}

const BODY_HEADERS = ['standard-server', 'content-disposition', 'content-type', 'content-length']

/**
 * Remove the headers describing a body that was replaced before it was sent,
 * keeping any that were changed since.
 */
function removeBodyHeaders(reply: AnyFastifyReply, headers: StandardHeaders): void {
  if (reply.raw.headersSent) {
    return
  }

  for (const key of BODY_HEADERS) {
    const value = headers[key]

    if (value === undefined) {
      continue
    }

    // fastify copies the reply headers to the raw response before piping a stream body,
    // and `reply.getHeader` falls back to them
    if (reply.raw.getHeader(key) === value) {
      reply.raw.removeHeader(key)
    }

    // fastify resets its own content-type and content-length for the error payload
    if (key !== 'content-type' && key !== 'content-length' && reply.getHeader(key) === value) {
      reply.removeHeader(key)
    }
  }
}
