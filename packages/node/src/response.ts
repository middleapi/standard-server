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
      // Set the head without committing it yet: `res.end(body)` commits it with a
      // content-length, which an early `res.writeHead` would turn into chunked encoding
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
        connection.once('close', () => {
          if (!resBody.closed) {
            resBody.destroy(getNodeResponseError(res) ?? undefined)
          }
        })

        // WARNING: a body error only destroys the response; the Promise rejects with it on
        // http2 (through the stream's error) but resolves on http1 (through `close`)
        resBody.once('error', (error) => res.destroy(error))

        // Commit the head here, as the first piped write would: Node validates some of
        // it only then (status range, http2 connection-specific or repeated single-value
        // headers, an http1 `trailer` without chunked encoding), and a throw from inside
        // the pipe escapes as an unhandled rejection instead of reaching the catch below.
        // (Both responses take this call, but TS can't call a union of overloads.)
        ;(res as { writeHead(statusCode: number): unknown }).writeHead(res.statusCode)

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
