import type { StandardUrl } from '@standard-server/core'
import { isStandardUrl } from '@standard-server/core'

import type { NodeHttpRequest } from './types'

// `scheme://authority` of an absolute-form request target (RFC 9112 §3.2.2)
const ABSOLUTE_FORM_PREFIX_REGEX = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i

export function toStandardUrl(req: Pick<NodeHttpRequest, 'originalUrl' | 'url'>): StandardUrl {
  // prefer originalUrl over url, especially useful in express.js middleware
  const url = req.originalUrl ?? req.url ?? '/'

  // origin-form, nearly all traffic, is already the raw path
  if (url.startsWith('/')) {
    return url as `/${string}`
  }

  // absolute-form: strip only scheme and authority, keep the path raw like origin-form
  // (dot segments are never resolved, as Express and Fastify don't when routing)
  const path = url.replace(ABSOLUTE_FORM_PREFIX_REGEX, '')

  return isStandardUrl(path) ? path : `/${path}`
}
