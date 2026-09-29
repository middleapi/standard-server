import type { StandardLazyRequest } from '@standard-server/core'
import type { ToStandardBodyOptions } from './body'
import type { AnyAPIGatewayProxyEvent, HttpResponseStream } from './types'
import { toAbortSignal } from '@standard-server/node'
import { toStandardBody } from './body'
import { toStandardHeaders } from './headers'
import { toStandardUrl } from './url'

export interface ToStandardLazyRequestOptions extends Omit<ToStandardBodyOptions, 'hint'> {
}

/**
 * Convert an API Gateway proxy event to a standard lazy request.
 */
export function toStandardLazyRequest(
  event: AnyAPIGatewayProxyEvent,
  responseStream: HttpResponseStream,
  options: ToStandardLazyRequestOptions = {},
): StandardLazyRequest {
  // DON'T lazy load signal, because we need register event listener as soon as possible
  // to make the signal abort in time
  const signal = toAbortSignal(responseStream)

  return {
    url: toStandardUrl(event),
    method: 'httpMethod' in event ? event.httpMethod : event.requestContext.http.method,
    get headers() {
      // lazy headers to improve performance
      const headers = toStandardHeaders(event)
      Object.defineProperty(this, 'headers', { value: headers, writable: true })
      return headers
    },
    set headers(value) {
      Object.defineProperty(this, 'headers', { value, writable: true })
    },
    resolveBody: hint => toStandardBody(event, { ...options, hint }),
    signal,
  }
}
