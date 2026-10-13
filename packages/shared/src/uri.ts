// with the u flag a well-formed surrogate pair is one code point, so only lone surrogates match
const LONE_SURROGATE_REGEX = /[\uD800-\uDFFF]/gu

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
 * `decodeURIComponent` that never throws, a value that fails to decode is returned as-is.
 */
export function safeDecodeURIComponent(value: string): string {
  if (!value.includes('%')) {
    return value
  }

  try {
    // oxlint-disable-next-line no-restricted-globals
    return decodeURIComponent(value)
  } catch {
    // retrying in parts would let a value with many malformed escapes cost one thrown URIError each
    return value
  }
}
