const LONE_SURROGATE_REGEX = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const PERCENT_ESCAPES_REGEX = /(?:%[0-9A-F]{2})+/gi

/**
 * `encodeURIComponent` that never throws, lone surrogates become U+FFFD.
 */
export function safeEncodeURIComponent(value: string): string {
  try {
    // eslint-disable-next-line no-restricted-globals
    return encodeURIComponent(value)
  }
  catch {
    // eslint-disable-next-line no-restricted-globals
    return encodeURIComponent(value.replace(LONE_SURROGATE_REGEX, '�'))
  }
}

/**
 * `decodeURIComponent` that never throws. On malformed input, each run of `%XX`
 * escapes that decodes on its own is still decoded, the rest is kept as-is.
 */
export function safeDecodeURIComponent(value: string): string {
  if (!value.includes('%')) {
    return value
  }

  try {
    // eslint-disable-next-line no-restricted-globals
    return decodeURIComponent(value)
  }
  catch {
    return value.replace(PERCENT_ESCAPES_REGEX, (escapes) => {
      try {
        // eslint-disable-next-line no-restricted-globals
        return decodeURIComponent(escapes)
      }
      catch {
        return escapes
      }
    })
  }
}
