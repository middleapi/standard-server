import type { StandardResponse } from '@standard-server/core'
import { cancelStandardBody } from '@standard-server/core'
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
  if (!canWriteToNodeResponse(reply.raw)) {
    const error = getNodeResponseError(reply.raw)

    // Release the body without converting it: converting an event stream already starts
    // its iterator, whose cleanup then waits behind a `next()` that may never settle.
    // WARNING: errors that occur here are silently ignored
    cancelStandardBody(standardResponse.body, error ?? undefined).catch(() => {})

    if (error) {
      throw error
    }

    return
  }

  const [resBody, resHeaders] = toNodeHttpBody(
    standardResponse.body,
    standardResponse.headers,
    options,
  )

  return new Promise((resolve, reject) => {
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

      // fastify pipes the stream body itself, no manual piping needed
      reply.send(resBody)
    } catch (error) {
      destroyNodeHttpBody(resBody, error, reject)

      // Don't destroy reply.raw: fastify's error handler can still send a response.
      reject(error)
    }
  })
}
