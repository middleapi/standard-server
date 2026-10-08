import type { StandardUrl } from '@standard-server/core'
import { escapeSchemeRelativePath } from '@standard-server/shared'

export function toStandardUrl(url: URL): StandardUrl {
  /* v8 ignore start - url.pathname always start with "/" */
  const pathname = `${url.pathname.startsWith('/') ? '' : '/'}${url.pathname}` as `/${string}`
  /* v8 ignore end  */
  // `http://h//x` has the pathname `//x`, which `new URL('//x', base)` would read as host `x`
  return `${escapeSchemeRelativePath(pathname)}${url.search}${url.hash}`
}
