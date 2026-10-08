import type { StandardUrl } from '@standard-server/core'
import { safeEncodeURIComponent } from '@standard-server/shared'

import type { AnyAPIGatewayProxyEvent } from './types'

// the WHATWG path percent-encode set, characters that can never appear literally in an encoded path
const UNENCODED_PATH_CHAR_RE = /[\0-\x20"#<>?^`{}\x7F-\u{10FFFF}]/gu

// anything but an RFC 3986 path character, a decoded path carries `%`, `\`, `?`, ... as data: left as-is,
// `URL` would decode `%2e%2e` again into a dot segment or treat `\` as `/`, resolving segments API Gateway never routed on
const DECODED_PATH_CHAR_RE = /[^A-Za-z0-9\-._~!$&'()*+,;=:@/]/gu

// anchored, so an HTTP API custom domain cannot pass for a Lambda Function URL
const FUNCTION_URL_DOMAIN_RE = /\.lambda-url\.[a-z0-9-]+\.on\.aws$/

/**
 * Build a standard url from an API Gateway proxy event.
 *
 * Payload format 1.0 query parameters are re-encoded (delivered url-decoded),
 * payload format 2.0's `rawQueryString` is used as-is.
 */
export function toStandardUrl(event: AnyAPIGatewayProxyEvent): StandardUrl {
  if (!('httpMethod' in event)) {
    // HTTP APIs deliver `rawPath` url-decoded, Lambda Function URLs still encoded
    const isDecoded = !FUNCTION_URL_DOMAIN_RE.test(event.requestContext.domainName ?? '')
    const pathname = toPathname(event.rawPath, isDecoded)

    return event.rawQueryString ? `${pathname}?${event.rawQueryString}` : pathname
  }

  // only HTTP APIs set `version` and deliver `path` url-decoded, REST APIs and ALB still encoded,
  // decoded is inferred from 2.0 captures: wrongly escaping costs a double-encoding, not escaping a traversal
  const pathname = toPathname(event.path, event.version === '1.0')

  const query = new URLSearchParams()

  if (event.multiValueQueryStringParameters) {
    for (const key of Object.keys(event.multiValueQueryStringParameters)) {
      const values = event.multiValueQueryStringParameters[key]
      for (const value of values ?? []) {
        query.append(key, value)
      }
    }
  }

  if (event.queryStringParameters) {
    for (const key of Object.keys(event.queryStringParameters)) {
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

function toPathname(path: string, isDecoded: boolean): `/${string}` {
  const encoded = path.replace(
    isDecoded ? DECODED_PATH_CHAR_RE : UNENCODED_PATH_CHAR_RE,
    safeEncodeURIComponent,
  )

  return encoded.startsWith('/') ? (encoded as `/${string}`) : `/${encoded}`
}
