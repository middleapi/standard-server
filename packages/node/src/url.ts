import type { StandardUrl } from '@standard-server/core'
import { toStandardUrl as toStandardUrlFetch } from '@standard-server/fetch'
import { escapeSchemeRelativePath } from '@standard-server/shared'

import type { NodeHttpRequest } from './types'

export function toStandardUrl(req: Pick<NodeHttpRequest, 'originalUrl' | 'url'>): StandardUrl {
  // prefer originalUrl over url, especially useful in express.js middleware
  const url = req.originalUrl ?? req.url ?? '/'

  if (url.startsWith('/')) {
    // origin-form is kept as-is, except `//host` or `/\host` that `new URL(url, base)` would read as a host
    return escapeSchemeRelativePath(url as `/${string}`)
  }

  try {
    const parsed = new URL(url, 'http://localhost')
    return toStandardUrlFetch(parsed)
  } catch {
    return escapeSchemeRelativePath(`/${url}`)
  }
}
