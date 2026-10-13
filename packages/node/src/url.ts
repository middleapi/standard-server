import type { StandardUrl } from '@standard-server/core'
import { isStandardUrl } from '@standard-server/core'

import type { NodeHttpRequest } from './types'

// `scheme://authority` of an absolute-form request target (RFC 9112 §3.2.2),
// the authority ends at the first `/`, `?` or `#` (RFC 3986 §3.2)
const ABSOLUTE_FORM_PREFIX_REGEX = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i

export function toStandardUrl(req: Pick<NodeHttpRequest, 'originalUrl' | 'url'>): StandardUrl {
  // prefer originalUrl over url, especially useful in express.js middleware
  const url = req.originalUrl ?? req.url ?? '/'

  // keep the path raw in both forms, like the host framework routes on it
  // (no dot-segment resolution, no decoding), origin-form never matches the prefix
  const path = url.replace(ABSOLUTE_FORM_PREFIX_REGEX, '')

  return isStandardUrl(path) ? path : `/${path}`
}
