import type { StandardUrl } from '@standard-server/core'
import type { AnyAPIGatewayProxyEvent } from './types'

const _encoder = new TextEncoder()

/**
 * Unsafe characters in a url-decoded path: the WHATWG path percent-encode set,
 * plus `%` so an already-literal percent is not read back as an escape sequence,
 * plus every non-ascii code point. Legal path characters such as `:@&+,;=~!$'()*`
 * are left alone so routes keep matching.
 */
const V1_UNSAFE_PATH_CHAR = /[^\x21-\x7E]|["#%<>?`{}]/gu

/**
 * `rawPath` already arrives percent-encoded, so only the two delimiters that would
 * reshape the standard url are escaped. A well-formed `rawPath` never carries them
 * verbatim, so this never double-encodes.
 */
const V2_UNSAFE_PATH_CHAR = /[#?]/g

function _encodePathname(pathname: string, unsafe: RegExp): string {
  return pathname.replace(unsafe, (char) => {
    let encoded = ''

    // TextEncoder, not encodeURIComponent: it maps a lone surrogate to U+FFFD
    // instead of throwing, so a malformed path cannot fail the request
    for (const byte of _encoder.encode(char)) {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }

    return encoded
  })
}

/**
 * Build a standard url from an API Gateway proxy event.
 *
 * Payload format 1.0 delivers both the path and the query parameters url-decoded,
 * so both are re-encoded: without it a percent-encoded `?` or `#` in the request
 * path would be read back as a query string or a fragment. Payload format 2.0's
 * `rawPath` and `rawQueryString` are already encoded and are used as-is.
 *
 * A percent-encoded `/` cannot be restored — API Gateway decodes it into a real
 * separator before the event is built, so the segment boundary is already lost.
 */
export function toStandardUrl(event: AnyAPIGatewayProxyEvent): StandardUrl {
  if (!('httpMethod' in event)) {
    const rawPath = `${event.rawPath.startsWith('/') ? '' : '/'}${event.rawPath}`
    const pathname = _encodePathname(rawPath, V2_UNSAFE_PATH_CHAR) as `/${string}`

    return event.rawQueryString ? `${pathname}?${event.rawQueryString}` : pathname
  }

  const path = `${event.path.startsWith('/') ? '' : '/'}${event.path}`
  const pathname = _encodePathname(path, V1_UNSAFE_PATH_CHAR) as `/${string}`

  const query = new URLSearchParams()

  if (event.multiValueQueryStringParameters) {
    for (const key in event.multiValueQueryStringParameters) {
      for (const value of event.multiValueQueryStringParameters[key] ?? []) {
        query.append(key, value)
      }
    }
  }

  if (event.queryStringParameters) {
    for (const key in event.queryStringParameters) {
      const value = event.queryStringParameters[key]
      // `multiValueQueryStringParameters` is a superset of `queryStringParameters`
      // in real events, only fill in keys it does not already carry
      if (value !== undefined && !query.has(key)) {
        query.append(key, value)
      }
    }
  }

  const search = query.toString()

  return search === '' ? pathname : `${pathname}?${search}`
}
