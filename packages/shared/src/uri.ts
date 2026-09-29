const LONE_SURROGATE_REGEX = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

// RFC 3629 UTF8-char spelled as `%XX` escapes, exactly what `decodeURIComponent` accepts
const UTF8_TAIL_ESCAPE = '%[89AB][0-9A-F]'
const UTF8_ESCAPES_REGEX = new RegExp(`(?:${[
  '%[0-7][0-9A-F]',
  `%(?:C[2-9A-F]|D[0-9A-F])${UTF8_TAIL_ESCAPE}`,
  `%(?:E0%[AB][0-9A-F]|E[1-9A-CEF]${UTF8_TAIL_ESCAPE}|ED%[89][0-9A-F])${UTF8_TAIL_ESCAPE}`,
  `%(?:F0%[9AB][0-9A-F]|F[1-3]${UTF8_TAIL_ESCAPE}|F4%8[0-9A-F])${UTF8_TAIL_ESCAPE}${UTF8_TAIL_ESCAPE}`,
].join('|')})+`, 'gi')

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
 * `decodeURIComponent` that never throws, malformed or non-UTF-8 escapes are kept as-is.
 */
export function safeDecodeURIComponent(value: string): string {
  if (!value.includes('%')) {
    return value
  }

  // eslint-disable-next-line no-restricted-globals
  return value.replace(UTF8_ESCAPES_REGEX, escapes => decodeURIComponent(escapes))
}
