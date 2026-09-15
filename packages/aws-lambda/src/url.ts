import type { StandardUrl } from '@standard-server/core'
import type { AnyAPIGatewayProxyEvent } from './types'

const UNENCODED_PATH_CHAR_RE = /[\0-\x20"#<>?^`{}\x7F-\u{10FFFF}]|%(?![0-9a-fA-F]{2})/gu

/**
 * Build a standard url from an API Gateway proxy event.
 *
 * Payload format 1.0 query parameters are re-encoded (delivered url-decoded),
 * payload format 2.0's `rawQueryString` is used as-is.
 */
export function toStandardUrl(event: AnyAPIGatewayProxyEvent): StandardUrl {
  if (!('httpMethod' in event)) {
    const pathname = toPathname(event.rawPath)

    return event.rawQueryString ? `${pathname}?${event.rawQueryString}` : pathname
  }

  const pathname = toPathname(event.path)

  const query = new URLSearchParams()

  if (event.multiValueQueryStringParameters) {
    for (const [key, values] of Object.entries(event.multiValueQueryStringParameters)) {
      for (const value of values ?? []) {
        query.append(key, value)
      }
    }
  }

  if (event.queryStringParameters) {
    for (const [key, value] of Object.entries(event.queryStringParameters)) {
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

function toPathname(path: string): `/${string}` {
  const encoded = path.replace(UNENCODED_PATH_CHAR_RE, encodeURIComponent)

  return encoded.startsWith('/') ? encoded as `/${string}` : `/${encoded}`
}
