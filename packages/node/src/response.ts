import type { StandardResponse } from '@standard-server/core'
import type { ServerResponse } from 'node:http'
import type { ToNodeHttpBodyOptions } from './body'
import type { NodeHttpResponse } from './types'
import { toNodeHttpBody } from './body'
import { canWriteToNodeResponse, getNodeResponseError } from './utils'

export interface SendStandardResponseOptions extends ToNodeHttpBodyOptions {
}

export async function sendStandardResponse(
  res: NodeHttpResponse,
  standardResponse: StandardResponse,
  options: SendStandardResponseOptions = {},
): Promise<void> {
  const [resBody, resHeaders] = toNodeHttpBody(standardResponse.body, standardResponse.headers, options)

  return new Promise((resolve, reject) => {
    if (!canWriteToNodeResponse(res)) {
      const error = getNodeResponseError(res)

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

    res.once('error', reject)
    res.once('close', resolve)

    try {
      // DON'T use `res.writeHead` here: it commits the head (chunked on http1, sent right away on http2),
      // while a buffered body should get its content-length from `res.end`
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
      }
      else if (typeof resBody === 'string') {
        res.end(resBody)
      }
      else {
        // Commit the head now: Node defers some status/header checks (e.g. an out-of-range status on http1,
        // connection-specific headers on http2) until it is written. Left to the first piped chunk, they
        // throw inside `pipe`'s data handler, crashing the process and leaving this promise unsettled.
        // (both response types accept a bare status, but their overloads don't unify)
        ;(res as ServerResponse).writeHead(standardResponse.status)

        res.once('close', () => {
          if (!resBody.closed) {
            resBody.destroy(getNodeResponseError(res) ?? undefined)
          }
        })

        // WARNING: errors that occur here are silently ignored and not reported to the Promise
        resBody.once('error', error => res.destroy(error))

        resBody.pipe(res)
      }
    }
    catch (error) {
      if (typeof resBody === 'object' && !resBody.closed) {
        resBody.on('error', reject)
        resBody.destroy(error as any)
      }

      // Destroy instead of leaving the response half-open: headers/status may be
      // partially applied, so the connection is no longer safe to reuse.
      res.destroy(error as any)
      reject(error)
    }
  })
}
