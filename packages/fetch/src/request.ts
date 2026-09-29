import type { StandardLazyRequest } from '@standard-server/core'
import type { ToStandardBodyOptions } from './body'
import { toStandardBody } from './body'
import { toStandardHeaders } from './headers'
import { toStandardUrl } from './url'

export interface ToStandardLazyRequestOptions extends Omit<ToStandardBodyOptions, 'hint'> {
}

/**
 * Convert a fetch request to a standard request.
 */
export function toStandardLazyRequest(
  request: Request,
  options: ToStandardLazyRequestOptions = {},
): StandardLazyRequest {
  const url = new URL(request.url)

  return {
    url: toStandardUrl(url),
    method: request.method,
    get headers() {
      // lazy headers to improve performance
      const headers = toStandardHeaders(request.headers)
      Object.defineProperty(this, 'headers', { value: headers, writable: true })
      return headers
    },
    set headers(value) {
      Object.defineProperty(this, 'headers', { value, writable: true })
    },
    resolveBody: hint => toStandardBody(request, { ...options, hint }),
    signal: request.signal,
  }
}
