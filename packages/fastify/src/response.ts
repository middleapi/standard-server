import type { StandardResponse } from '@standard-server/core'
import type { ToNodeHttpBodyOptions } from '@standard-server/node'
import type { AnyFastifyReply } from './types'
import { canWriteToNodeResponse, getNodeResponseError, toNodeHttpBody } from '@standard-server/node'

export interface SendStandardResponseOptions extends ToNodeHttpBodyOptions {
}

export async function sendStandardResponse(
  reply: AnyFastifyReply,
  standardResponse: StandardResponse,
  options: SendStandardResponseOptions = {},
): Promise<void> {
  const [resBody, resHeaders] = toNodeHttpBody(standardResponse.body, standardResponse.headers, options)

  return new Promise((resolve, reject) => {
    if (!canWriteToNodeResponse(reply.raw)) {
      const error = getNodeResponseError(reply.raw)

      if (typeof resBody === 'object' && !resBody.closed) {
        resBody.on('error', reject)
        resBody.destroy(error ?? undefined)
      }

      if (error) {
        reject(error)
      }
      else {
        resolve()
      }

      return
    }

    reply.raw.once('error', reject)
    reply.raw.once('close', resolve)

    try {
      reply.status(standardResponse.status)

      // DON'T pass headers with `undefined` value to fastify, it turns them into empty strings
      for (const [key, value] of Object.entries(resHeaders)) {
        if (value !== undefined) {
          reply.header(key, value)
        }
      }

      // fastify pipes and cleans up the stream body itself, no manual piping needed
      reply.send(resBody)
    }
    catch (error) {
      if (typeof resBody === 'object' && !resBody.closed) {
        resBody.on('error', reject)
        resBody.destroy(error as any)
      }

      // Don't destroy reply.raw: fastify's error handler can still send a response.
      reject(error)
    }
  })
}
