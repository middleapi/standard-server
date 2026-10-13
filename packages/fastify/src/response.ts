import type { StandardResponse } from '@standard-server/core'
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
          // Copy arrays: fastify stores them by reference, and later set-cookie writers
          // (e.g. @fastify/cookie on onSend) push into them, mutating the caller's array.
          reply.header(key, Array.isArray(value) ? [...value] : value)
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
