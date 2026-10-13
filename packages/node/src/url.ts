import type { StandardUrl } from '@standard-server/core'

import type { NodeHttpRequest } from './types'

/**
 * Matches the `scheme://authority` prefix of an absolute-form request target (RFC 9112 §3.2.2).
 * The authority ends at the first `/`, `?` or `#` (RFC 3986 §3.2).
 */
const ABSOLUTE_FORM_PREFIX_REGEX = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i

export function toStandardUrl(req: Pick<NodeHttpRequest, 'originalUrl' | 'url'>): StandardUrl {
  // prefer originalUrl over url, especially useful in express.js middleware
  const url = req.originalUrl ?? req.url ?? '/'

  if (url.startsWith('/')) {
    return url as `/${string}`
  }

  // Strip only scheme and authority and keep the rest byte-for-byte, so absolute-form yields the same
  // raw path as origin-form and as the host framework routed on (no dot-segment resolution, no decoding)
  const prefix = ABSOLUTE_FORM_PREFIX_REGEX.exec(url)
  const rest = prefix ? url.slice(prefix[0].length) : url

  return rest.startsWith('/') ? (rest as `/${string}`) : `/${rest}`
}
