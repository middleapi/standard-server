import type { StandardResponse } from '@standard-server/core'
import type { ToNodeHttpBodyOptions } from './body'
import type { NodeHttpResponse } from './types'
import { Http2ServerResponse } from 'node:http2'
import { isAsyncIteratorObject } from '@standard-server/shared'
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
      // DON'T use `res.writeHead` because it send response immediately in chunked mode
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
      }
      else if (typeof resBody === 'string') {
        res.end(resBody)
      }
      else {
        res.once('close', () => {
          if (!resBody.closed) {
            resBody.destroy(getNodeResponseError(res) ?? undefined)
          }
        })

        // WARNING: errors that occur here are silently ignored and not reported to the Promise
        resBody.once('error', error => res.destroy(error))

        // Node holds the status and headers back until the first chunk is written,
        // so send them now: a stream can take a while to produce its first chunk.
        if (standardResponse.body instanceof ReadableStream || isAsyncIteratorObject(standardResponse.body)) {
          if (res instanceof Http2ServerResponse) {
            // http2 responses document `writeHead`, not `flushHeaders`, for this
            res.writeHead(standardResponse.status)
          }
          else {
            res.flushHeaders()
          }
        }

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
