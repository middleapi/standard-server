import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import type { StandardResponse } from '@standard-server/core'
import type { ToNodeHttpBodyOptions } from '@standard-server/node'
import {
  canNodeResponseHaveBody,
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
      const hasBody = canNodeResponseHaveBody(reply.raw, standardResponse.status)

      if (!hasBody) {
        if (standardResponse.status === 204 || standardResponse.status === 205) {
          // No content to describe, and an http2 client rejects these with a content-length
          resHeaders['content-type'] = undefined
          resHeaders['content-length'] = undefined
        } else if (typeof resBody === 'string') {
          // Still announce the length of the body left out, as fastify does for a string payload
          resHeaders['content-length'] = Buffer.byteLength(resBody).toString()
        }
      }

      reply.status(standardResponse.status)

      // DON'T pass headers with `undefined` value to fastify, it turns them into empty strings
      for (const key of Object.keys(resHeaders)) {
        const value = resHeaders[key]
        if (value !== undefined) {
          reply.header(key, value)
        }
      }

      if (hasBody) {
        // fastify pipes the stream body itself, no manual piping needed
        reply.send(resBody)
      } else {
        // Release instead of letting fastify write a body the response cannot carry: on http2,
        // Node ends the stream with the headers, so any write would fail as a write after end
        destroyNodeHttpBody(resBody, undefined, reject)

        // An empty stream, not `undefined`, keeps the headers as they are: without a payload,
        // an auto-exposed HEAD route replaces the content-length with 0
        reply.send(reply.request.method === 'HEAD' ? Readable.from([]) : undefined)
      }
    } catch (error) {
      destroyNodeHttpBody(resBody, error, reject)

      // Don't destroy reply.raw: fastify's error handler can still send a response.
      reject(error)
    }
  })
}
