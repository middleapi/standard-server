import type { StandardResponse } from '@standard-server/core'
import { cancelStandardBody } from '@standard-server/core'
import type { ToNodeHttpBodyOptions } from '@standard-server/node'
import {
  canWriteToNodeResponse,
  destroyNodeHttpBody,
  getNodeResponseError,
  toNodeHttpBody,
} from '@standard-server/node'

import { toLambdaHeaders } from './headers'
import type { AwsLambdaGlobal, HttpResponseStream } from './types'

/**
 * Injected by the Lambda runtime when response streaming is enabled.
 * Declared module-locally to keep the consumer's global types clean.
 */
declare const awslambda: AwsLambdaGlobal

export interface SendStandardResponseOptions extends ToNodeHttpBodyOptions {}

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
  if (!canWriteToNodeResponse(responseStream)) {
    const error = getNodeResponseError(responseStream)

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
    responseStream.once('error', reject)
    responseStream.once('close', resolve)

    try {
      const [headers, setCookies] = toLambdaHeaders(resHeaders)

      // arms the metadata prelude (status, headers, cookies) and
      // returns the stream the body should be written to
      const res = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: standardResponse.status,
        headers,
        cookies: setCookies,
      })

      // The runtime only sends the armed prelude ahead of the first `write` call:
      // `end(chunk)` bypasses it and an empty body never writes, so trigger it now
      res.write('')

      if (resBody === undefined) {
        // NOTE: Lambda functions don't allow passing undefined to `res.end`
        res.end()
      } else if (typeof resBody === 'string') {
        res.end(resBody)
      } else {
        res.once('close', () => {
          if (!resBody.closed) {
            resBody.destroy(getNodeResponseError(res) ?? undefined)
          }
        })

        resBody.once('error', (error) => res.destroy(error))

        resBody.pipe(res)
      }
    } catch (error) {
      destroyNodeHttpBody(resBody, error, reject)

      // Destroy instead of leaving the response half-open:
      // the metadata prelude may be partially applied
      responseStream.destroy(error as any)
      reject(error)
    }
  })
}
