import type { StandardBodyHint, StandardHeaders, StandardUrl } from './types'
import { safeDecodeURIComponent, safeEncodeURIComponent, toArray } from '@standard-server/shared'

export function generateContentDisposition(filename: string, type: 'inline' | 'attachment' = 'inline'): string {
  const encodedFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/[\\"]/g, '\\$&')

  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent#encoding_for_content-disposition_and_link_headers
  const encodedFilenameStar = safeEncodeURIComponent(filename)
    .replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%(7C|60|5E)/g, (str, hex) => String.fromCharCode(Number.parseInt(hex, 16)))

  return `${type}; filename="${encodedFilename}"; filename*=utf-8''${encodedFilenameStar}`
}

export function getFilenameFromContentDisposition(contentDisposition: string): string | undefined {
  const extValue = contentDisposition.match(/(?:^|;)\s*filename\*=([^;]*)/i)?.[1]?.trim()

  // RFC 8187 ext-value: charset "'" [ language ] "'" value-chars
  const extValueMatch = extValue?.match(/^([^']*)'[^']*'(.*)$/)

  if (extValueMatch) {
    const [, charset = '', encodedFilename = ''] = extValueMatch

    if (/^(?:utf-8|us-ascii)$/i.test(charset)) {
      return safeDecodeURIComponent(encodedFilename)
    }
    // unsupported charset: fall through to the plain filename param
  }
  else if (extValue) {
    // lenient: some senders omit the charset prefix entirely
    return safeDecodeURIComponent(extValue)
  }

  const filenameMatch = contentDisposition.match(/(?:^|;)\s*filename=(?:"((?:\\.|[^"\\])*)"|([^";]*))/i)

  if (filenameMatch?.[1] !== undefined) {
    return filenameMatch[1].replace(/\\(.)/g, '$1')
  }

  return filenameMatch?.[2]?.trim() || undefined
}

export function flattenStandardHeader(header: string | readonly string[] | undefined): string | undefined {
  if (typeof header === 'string' || header === undefined) {
    return header
  }

  if (header.length === 0) {
    return undefined
  }

  return header.join(', ')
}

const STANDARD_BODY_HINT_SET: ReadonlySet<string> = new Set<StandardBodyHint>([
  'json',
  'form-data',
  'url-search-params',
  'event-stream',
  'octet-stream',
  'file',
  'none',
])

/**
 * Resolves how a receiver parses a body from the standard headers alone,
 * mirroring what the body parsers do.
 */
export function resolveStandardBodyHint(headers: {
  'standard-server'?: undefined | string | string[]
  'content-type'?: undefined | string | string[]
  'content-length'?: undefined | string | string[]
  'content-disposition'?: undefined | string | string[]
}): StandardBodyHint {
  const hint = flattenStandardHeader(headers['standard-server'])

  if (hint !== undefined && STANDARD_BODY_HINT_SET.has(hint)) {
    return hint as StandardBodyHint
  }

  // media types are case-insensitive, the hint is our own header so it stays exact
  const mimeType = flattenStandardHeader(headers['content-type'])?.split(';')[0]?.trim().toLowerCase()
  const contentLength = flattenStandardHeader(headers['content-length'])
  const contentDisposition = flattenStandardHeader(headers['content-disposition'])
  const fileName = contentDisposition !== undefined ? getFilenameFromContentDisposition(contentDisposition) : undefined

  if (mimeType === undefined && (contentLength === undefined || contentLength === '0')) {
    return 'none'
  }

  if (mimeType === 'application/json') {
    return 'json'
  }

  if (mimeType === 'multipart/form-data') {
    return 'form-data'
  }

  if (mimeType === 'application/x-www-form-urlencoded') {
    return 'url-search-params'
  }

  if (mimeType === 'text/event-stream') {
    return 'event-stream'
  }

  if (fileName !== undefined || contentLength !== undefined) {
    return 'file'
  }

  return 'octet-stream'
}

export function mergeStandardHeaders(a: StandardHeaders, b: StandardHeaders): StandardHeaders {
  const merged = { ...a, ...b }

  for (const [key, bValue] of Object.entries(b)) {
    if (!Object.hasOwn(a, key)) {
      continue
    }

    const aValue = a[key]

    merged[key] = aValue === undefined || bValue === undefined
      ? aValue ?? bValue
      : [...toArray(aValue), ...toArray(bValue)]
  }

  return merged
}

export function parseStandardUrl(url: StandardUrl): [
  pathname: `/${string}`,
  search: `?${string}` | undefined,
  hash: `#${string}` | undefined,
] {
  const hashStart = url.indexOf('#')
  const searchStart = url.indexOf('?')

  const hasSearchBeforeHash = searchStart !== -1 && (hashStart === -1 || searchStart < hashStart)
  const pathnameEnd = hasSearchBeforeHash ? searchStart : hashStart !== -1 ? hashStart : url.length
  const searchEnd = hashStart !== -1 ? hashStart : url.length

  const pathname = url.slice(0, pathnameEnd) as `/${string}`
  const search = hasSearchBeforeHash ? url.slice(searchStart, searchEnd) as `?${string}` : undefined
  const hash = hashStart !== -1 ? url.slice(hashStart) as `#${string}` : undefined

  return [pathname, search, hash]
}
