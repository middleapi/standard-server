import type { StandardLazyResponse, StandardResponse } from '@standard-server/core'
import type { ToFetchBodyOptions, ToStandardBodyOptions } from './body'
import { toFetchBody, toStandardBody } from './body'
import { toFetchHeaders, toStandardHeaders } from './headers'

export interface ToFetchResponseOptions extends ToFetchBodyOptions {
}

export function toFetchResponse(
  standardResponse: StandardResponse,
  options: ToFetchResponseOptions = {},
): Response {
  const [body, standardHeaders] = toFetchBody(standardResponse.body, standardResponse.headers, options)

  try {
    const response = new Response(body, {
      headers: toFetchHeaders(standardHeaders),
      status: standardResponse.status,
    })

    // not sure why, but some tests (@hono/node-server) fail without pre-accessing body
    void response.body

    return response
  }
  catch (error) {
    if (body instanceof ReadableStream) {
      body.cancel(error).catch(() => {})
    }

    throw error
  }
}

export interface ToStandardLazyResponseOptions extends Omit<ToStandardBodyOptions, 'hint'> {
}

export function toStandardLazyResponse(
  response: Response,
  options: ToStandardLazyResponseOptions = {},
): StandardLazyResponse {
  return {
    resolveBody: hint => toStandardBody(response, { ...options, hint }),
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
