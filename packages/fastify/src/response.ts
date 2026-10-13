import { Readable } from 'node:stream'

import type { StandardResponse } from '@standard-server/core'
import type { ToNodeHttpBodyOptions } from '@standard-server/node'
import {
  canWriteToNodeResponse,
  destroyNodeHttpBody,
  getNodeResponseError,
  isBodylessNodeResponse,
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

      if (
        typeof resBody === 'object' &&
        isBodylessNodeResponse(reply.raw, standardResponse.status)
      ) {
        // Node would drop the body anyway, and on an explicit HEAD route or a 304 fastify
        // pipes it into a response that only ends once the source does, so release it unread.
        // Send an empty stream rather than nothing: fastify's auto HEAD route would replace
        // the content-length with 0 for a missing payload.
        destroyNodeHttpBody(resBody, undefined, reject)
        reply.send(Readable.from([]))
      } else {
        // fastify pipes the stream body itself, no manual piping needed
        reply.send(resBody)
      }
    } catch (error) {
      destroyNodeHttpBody(resBody, error, reject)

      // Don't destroy reply.raw: fastify's error handler can still send a response.
      reject(error)
    }
  })
}
