import type { StandardBody, StandardBodyHint, StandardHeaders, StandardResponse, StandardUrl } from './types'
import { isAsyncIteratorObject, safeDecodeURIComponent, safeEncodeURIComponent, toArray } from '@standard-server/shared'

const FALLBACK_FILENAME_UNSAFE_CHAR_REGEX = /[^\x20-\x7E]|[;=]/g
const QUOTED_STRING_SPECIAL_CHAR_REGEX = /[\\"]/g
const QUOTED_PAIR_REGEX = /\\(.)/g

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent#encoding_for_content-disposition_and_link_headers
const EXT_VALUE_RESERVED_CHAR_REGEX = /['()*]/g
const EXT_VALUE_ALLOWED_ESCAPE_REGEX = /%(7C|60|5E)/g

// RFC 8187 ext-value: charset "'" [ language ] "'" value-chars
const EXT_VALUE_REGEX = /^([^']*)'[^']*'(.*)$/
const EXT_VALUE_SUPPORTED_CHARSET_REGEX = /^(?:utf-8|us-ascii)$/i

const CONTENT_DISPOSITION_PARAM_REGEX = /[\s;]*([^;=]*)(?:=\s*(?:"((?:\\.|[^"\\])*)"[^;]*|"[\s\S]*|([^;]*)))?/y

export function generateContentDisposition(filename: string, type: 'inline' | 'attachment' = 'inline'): string {
  const encodedFilename = filename
    .replace(FALLBACK_FILENAME_UNSAFE_CHAR_REGEX, '_')
    .replace(QUOTED_STRING_SPECIAL_CHAR_REGEX, '\\$&')

  const encodedFilenameStar = safeEncodeURIComponent(filename)
    .replace(EXT_VALUE_RESERVED_CHAR_REGEX, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(EXT_VALUE_ALLOWED_ESCAPE_REGEX, (str, hex) => String.fromCharCode(Number.parseInt(hex, 16)))

  return `${type}; filename="${encodedFilename}"; filename*=utf-8''${encodedFilenameStar}`
}

function getContentDispositionParam(contentDisposition: string, name: string): string | undefined {
  CONTENT_DISPOSITION_PARAM_REGEX.lastIndex = 0

  while (CONTENT_DISPOSITION_PARAM_REGEX.lastIndex < contentDisposition.length) {
    const [, paramName = '', quoted, token] = CONTENT_DISPOSITION_PARAM_REGEX.exec(contentDisposition)!

    if (paramName.trimEnd().toLowerCase() === name) {
      return quoted !== undefined
        ? quoted.replace(QUOTED_PAIR_REGEX, '$1')
        : token?.trim() || undefined
    }
  }

  return undefined
}

export function getFilenameFromContentDisposition(contentDisposition: string): string | undefined {
  const extValue = getContentDispositionParam(contentDisposition, 'filename*')
  const extValueMatch = extValue?.match(EXT_VALUE_REGEX)

  if (extValueMatch) {
    const [, charset = '', encodedFilename = ''] = extValueMatch

    if (EXT_VALUE_SUPPORTED_CHARSET_REGEX.test(charset)) {
      return safeDecodeURIComponent(encodedFilename)
    }
  }
  else if (extValue) {
    return safeDecodeURIComponent(extValue)
  }

  return getContentDispositionParam(contentDisposition, 'filename')
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

/**
 * Cancel a body that will not be consumed, so its stream or iterator source can clean up.
 * Other bodies are left as is. Rejects if that cleanup fails.
 */
export async function cancelStandardBody(body: StandardBody, reason?: unknown): Promise<void> {
  if (body instanceof ReadableStream) {
    await body.cancel(reason)
  }
  else if (isAsyncIteratorObject(body)) {
    await body.return?.()
  }
}

/**
 * Get the body a response can send: `undefined` when its status forbids one
 * (204 No Content, 205 Reset Content, 304 Not Modified), so it is sent as if it had no body.
 * A dropped stream or async iterator body is cancelled, so its source can clean up.
 *
 * HEAD responses and 1xx statuses are left to the runtime.
 */
export function getSendableResponseBody(response: StandardResponse): StandardBody {
  const status = response.status

  if (status !== 204 && status !== 205 && status !== 304) {
    return response.body
  }

  // nothing waits on a body that is never sent, so a failed cleanup has no one to report to
  cancelStandardBody(response.body).catch(() => {})

  return undefined
}

export function mergeStandardHeaders(a: StandardHeaders, b: StandardHeaders): StandardHeaders {
  const merged = { ...a, ...b }

  for (const key of Object.keys(b)) {
    if (!Object.hasOwn(a, key)) {
      continue
    }

    const aValue = a[key]
    const bValue = b[key]

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
