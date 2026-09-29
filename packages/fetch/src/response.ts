import type { StandardLazyResponse, StandardResponse } from '@standard-server/core'
import type { ToFetchBodyOptions } from './body'
import { toFetchBody, toStandardBody } from './body'
import { toFetchHeaders, toStandardHeaders } from './headers'

export interface ToFetchResponseOptions extends ToFetchBodyOptions {
}

export function toFetchResponse(
  standardResponse: StandardResponse,
  options: ToFetchResponseOptions = {},
): Response {
  const [body, standardHeaders] = toFetchBody(standardResponse.body, standardResponse.headers, options)
  const response = new Response(body, {
    headers: toFetchHeaders(standardHeaders),
    status: standardResponse.status,
  })

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
