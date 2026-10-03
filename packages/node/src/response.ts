import type { ServerResponse } from 'node:http'

import type { StandardResponse } from '@standard-server/core'

import type { ToNodeHttpBodyOptions } from './body'
import { toNodeHttpBody } from './body'
import type { NodeHttpResponse } from './types'
import { canWriteToNodeResponse, destroyNodeHttpBody, getNodeResponseError } from './utils'

export interface SendStandardResponseOptions extends ToNodeHttpBodyOptions {}

export async function sendStandardResponse(
  res: NodeHttpResponse,
  standardResponse: StandardResponse,
  options: SendStandardResponseOptions = {},
): Promise<void> {
  const [resBody, resHeaders] = toNodeHttpBody(
    standardResponse.body,
    standardResponse.headers,
    options,
  )

  return new Promise((resolve, reject) => {
    if (!canWriteToNodeResponse(res)) {
      const error = getNodeResponseError(res)

      destroyNodeHttpBody(resBody, error, reject)

      if (error) {
        reject(error)
      } else {
        resolve()
      }

      return
    }

    const connection = 'stream' in res ? res.stream : res

    connection.once('error', reject)
    connection.once('close', resolve)

    try {
      // DON'T use `res.writeHead` here because it send response immediately in chunked mode
      // while we only need chunked if the response body is stream
      res.statusCode = standardResponse.status
      for (const key of Object.keys(resHeaders)) {
        const value = resHeaders[key]
        if (value !== undefined) {
          res.setHeader(key, value)
        }
      }

      if (resBody === undefined) {
        // NOTE: Lambda functions don't allow passing undefined to `res.end`
        res.end()
      } else if (typeof resBody === 'string') {
        res.end(resBody)
      } else {
        // Node validates the status and headers (e.g. HTTP/2 connection-specific ones) only when
        // writing them. The first `write` of `pipe` would do that from the body's `data` handler,
        // where a throw escapes this try/catch and crashes the process, so write them here instead.
        // (the cast only picks an overload: TS can't call `writeHead` on the union)
        ;(res as ServerResponse).writeHead(res.statusCode)

        connection.once('close', () => {
          if (!resBody.closed) {
            resBody.destroy(getNodeResponseError(res) ?? undefined)
          }
        })

        // WARNING: errors that occur here are silently ignored and not reported to the Promise
        resBody.once('error', (error) => res.destroy(error))

        resBody.pipe(res)
      }
    } catch (error) {
      destroyNodeHttpBody(resBody, error, reject)

      // Destroy instead of leaving the response half-open: headers/status may be
      // partially applied, so the connection is no longer safe to reuse.
      res.destroy(error as any)
      reject(error)
    }
  })
}
