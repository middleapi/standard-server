import type { StandardLazyResponse, StandardResponse } from '@standard-server/core'
import type { ToFetchBodyOptions } from './body'
import { cancelStandardBody } from '@standard-server/core'
import { toFetchBody, toStandardBody } from './body'
import { toFetchHeaders, toStandardHeaders } from './headers'

/**
 * Statuses a fetch Response rejects any body for (101 and 103 are out of range anyway).
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304])

export interface ToFetchResponseOptions extends ToFetchBodyOptions {
}

/**
 * Convert a standard response to a fetch response.
 *
 * The body of a 204, 205 or 304 response is dropped (and released) instead of throwing,
 * since fetch forbids one (node's http drops it for 204 and 304 as well).
 */
export function toFetchResponse(
  standardResponse: StandardResponse,
  options: ToFetchResponseOptions = {},
): Response {
  let standardBody = standardResponse.body

  if (NULL_BODY_STATUSES.has(standardResponse.status)) {
    // Drop it before converting, so an event stream never starts pulling its iterator.
    // Cleanup failures are ignored: there is nowhere to report them.
    cancelStandardBody(standardBody).catch(() => {})
    standardBody = undefined
  }

  const [body, standardHeaders] = toFetchBody(standardBody, standardResponse.headers, options)

  let response: Response

  try {
    response = new Response(body, {
      headers: toFetchHeaders(standardHeaders),
      status: standardResponse.status,
    })
  }
  catch (error) {
    // The body will never be read: release its source (an event stream has already started
    // pulling its iterator and arming keep-alive). The conversion error is what gets reported.
    cancelStandardBody(body, error).catch(() => {})
    throw error
  }

  // not sure why, but some tests (@hono/node-server) fail without pre-accessing body
  void response.body

  return response
}

export function toStandardLazyResponse(
  response: Response,
): StandardLazyResponse {
  return {
    resolveBody: hint => toStandardBody(response, { hint }),
    status: response.status,
    get headers() {
      // lazy headers to improve performance
      const headers = toStandardHeaders(response.headers)
      Object.defineProperty(this, 'headers', { value: headers, writable: true })
      return headers
    },
    set headers(value) {
      Object.defineProperty(this, 'headers', { value, writable: true })
    },
  }
}
