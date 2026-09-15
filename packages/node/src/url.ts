import type { StandardUrl } from '@standard-server/core'
import type { NodeHttpRequest } from './types'
import { toStandardUrl as toStandardUrlFetch } from '@standard-server/fetch'

export function toStandardUrl(req: Pick<NodeHttpRequest, 'originalUrl' | 'url'>): StandardUrl {
  // prefer originalUrl over url, especially useful in express.js middleware
  const url = req.originalUrl ?? req.url ?? '/'

  if (url.startsWith('/')) {
    return url as `/${string}`
  }

  try {
    const parsed = new URL(url, 'http://localhost')
    return toStandardUrlFetch(parsed)
  }
  catch {
    return `/${url}`
  }
}
