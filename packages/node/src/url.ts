import type { StandardUrl } from '@standard-server/core'
import type { NodeHttpRequest } from './types'

/**
 * The `http(s)://authority` prefix of an absolute-form request target (RFC 9112 §3.2.2).
 *
 * Only authorities that every router splits in the same place match: a non-empty reg-name,
 * IPv4 or IPv6 literal with an optional numeric port, and an optional userinfo, none of
 * them containing `\`. Express (`url.parse`) ends the host early on `%`, `'`, `;` and `\`,
 * and doesn't strip `javascript://`, while find-my-way hands other schemes unstripped to
 * catch-all routes, so anything else could be routed on a different path than returned here.
 */
const HTTP_ABSOLUTE_FORM_PREFIX_REGEX = /^https?:\/\/(?:[^/?#\\]*@)?(?:[\w\-.~!$&()*+,=]+|\[[\da-f:.]+\])(?::\d*)?(?=[/?#]|$)/i

export function toStandardUrl(req: Pick<NodeHttpRequest, 'originalUrl' | 'url'>): StandardUrl {
  // prefer originalUrl over url, especially useful in express.js middleware
  const url = req.originalUrl ?? req.url ?? '/'

  if (url.startsWith('/')) {
    return url as `/${string}`
  }

  const prefix = HTTP_ABSOLUTE_FORM_PREFIX_REGEX.exec(url)?.[0]

  if (prefix !== undefined) {
    try {
      // only to reject what routers reject too (out-of-range port, malformed IP literal, ...),
      // the path itself is kept byte-for-byte: routers and path-scoped middleware see it raw,
      // so resolving dot segments or backslashes here would let a request skip them
      void new URL(url)

      const path = url.slice(prefix.length)
      return path.startsWith('/') ? path as `/${string}` : `/${path}`
    }
    catch {}
  }

  return `/${url}`
}
