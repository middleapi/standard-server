import type { StandardLazyRequest } from '@standard-server/core'

import { toStandardBody } from './body.ts'
import { toStandardHeaders } from './headers.ts'
import { toStandardUrl } from './url.ts'

/**
 * Convert a fetch request to a standard request.
 */
export function toStandardLazyRequest(request: Request): StandardLazyRequest {
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
    resolveBody: (hint) => toStandardBody(request, { hint }),
    signal: request.signal,
  }
}
