const LONE_SURROGATE_REGEX =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const PERCENT_ESCAPES_REGEX = /(?:%[0-9A-F]{2})+/gi
// WHATWG URL strips tabs and newlines, then reads `//` or `/\` (http/https) as the start of a host
const SCHEME_RELATIVE_PATH_PREFIX_REGEX = /^\/[\t\n\r]*[/\\]/

/**
 * `encodeURIComponent` that never throws, lone surrogates become U+FFFD.
 */
export function safeEncodeURIComponent(value: string): string {
  try {
    // oxlint-disable-next-line no-restricted-globals
    return encodeURIComponent(value)
  } catch {
    // oxlint-disable-next-line no-restricted-globals
    return encodeURIComponent(value.replace(LONE_SURROGATE_REGEX, '�'))
  }
}

/**
 * `decodeURIComponent` that never throws, runs of `%XX` escapes that fail to decode are kept as-is.
 */
export function safeDecodeURIComponent(value: string): string {
  if (!value.includes('%')) {
    return value
  }

  try {
    // oxlint-disable-next-line no-restricted-globals
    return decodeURIComponent(value)
  } catch {
    return value.replace(PERCENT_ESCAPES_REGEX, (escapes) => {
      try {
        // oxlint-disable-next-line no-restricted-globals
        return decodeURIComponent(escapes)
      } catch {
        return escapes
      }
    })
  }
}

/**
 * Percent-encode the characters after the leading `/` of a path `URL` would read as scheme-relative,
 * so `new URL(path, base)` keeps the base host and the whole path.
 *
 * @example escapeSchemeRelativePath('//evil.com/admin') // '/%2Fevil.com/admin'
 */
export function escapeSchemeRelativePath(path: `/${string}`): `/${string}` {
  return path.replace(
    SCHEME_RELATIVE_PATH_PREFIX_REGEX,
    (prefix) => `/${safeEncodeURIComponent(prefix.slice(1))}`,
  ) as `/${string}`
}
