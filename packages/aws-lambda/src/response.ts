import type { StandardResponse } from '@standard-server/core'
import type { ToNodeHttpBodyOptions } from '@standard-server/node'
import type { AwsLambdaGlobal, HttpResponseStream } from './types'
import { canWriteToNodeResponse, getNodeResponseError, toNodeHttpBody } from '@standard-server/node'
import { toLambdaHeaders } from './headers'

/**
 * Injected by the Lambda runtime when response streaming is enabled.
 * Declared module-locally to keep the consumer's global types clean.
 */
declare const awslambda: AwsLambdaGlobal

export interface SendStandardResponseOptions extends ToNodeHttpBodyOptions {
}

/**
 * Send a standard response through the stream `awslambda.streamifyResponse` provides.
 *
 * Requires the Lambda Node.js runtime with response streaming enabled.
 */
export async function sendStandardResponse(
  responseStream: HttpResponseStream,
  standardResponse: StandardResponse,
  options: SendStandardResponseOptions = {},
): Promise<void> {
  const [resBody, resHeaders] = toNodeHttpBody(standardResponse.body, standardResponse.headers, options)

  return new Promise((resolve, reject) => {
    if (!canWriteToNodeResponse(responseStream)) {
      const error = getNodeResponseError(responseStream)

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

    const [headers, setCookies] = toLambdaHeaders(resHeaders)

    // arms the metadata prelude (status, headers, cookies) and
    // returns the stream the body should be written to
    const res = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: standardResponse.status,
      headers,
      cookies: setCookies,
    })

    res.once('error', reject)
    res.once('close', resolve)

    // The runtime only sends the armed prelude ahead of the first `write` call:
    // `end(chunk)` bypasses it and an empty body never writes, so trigger it now
    res.write('')

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

      resBody.pipe(res)
    }
  })
}
