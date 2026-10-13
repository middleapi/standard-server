import type { StandardUrl } from '@standard-server/core'
import { safeEncodeURIComponent } from '@standard-server/shared'

import type { AnyAPIGatewayProxyEvent } from './types'

const UNENCODED_PATH_CHAR_RE = /[\0-\x20"#<>?^`{}\x7F-\u{10FFFF}]/gu

/**
 * A decoded path also escapes `%` and `\`, a literal `%` would otherwise be decoded a second time
 * downstream, and `URL` resolves a `\` like a `/` in http(s) urls.
 */
const DECODED_PATH_UNENCODED_CHAR_RE = /[\0-\x20"#%<>?\\^`{}\x7F-\u{10FFFF}]/gu

export interface ToStandardUrlOptions {
  /**
   * Whether the event path is already url-decoded, a decoded path also escapes `%` and `\`.
   *
   * @default true for HTTP API events: payload format 1.0 with `version: '1.0'`,
   * payload format 2.0 with a `requestContext.domainName` other than a Lambda Function URL's
   */
  decodedPath?: boolean
}

/**
 * Build a standard url from an API Gateway proxy event.
 *
 * Payload format 1.0 query parameters are re-encoded (delivered url-decoded),
 * payload format 2.0's `rawQueryString` is used as-is.
 */
export function toStandardUrl(
  event: AnyAPIGatewayProxyEvent,
  options: ToStandardUrlOptions = {},
): StandardUrl {
  const decodedPath = options.decodedPath ?? isHttpApiEvent(event)

  if (!('httpMethod' in event)) {
    const pathname = toPathname(event.rawPath, decodedPath)

    return event.rawQueryString ? `${pathname}?${event.rawQueryString}` : pathname
  }

  const pathname = toPathname(event.path, decodedPath)

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

/**
 * Only a positively identified HTTP API event counts, anything else is treated as still encoded.
 */
function isHttpApiEvent(event: AnyAPIGatewayProxyEvent): boolean {
  if ('httpMethod' in event) {
    // REST API events carry no top-level `version`
    return event.version === '1.0'
  }

  // Lambda Function URLs share payload format 2.0, only their domain tells them apart
  const domainName = event.requestContext.domainName

  return typeof domainName === 'string' && !domainName.includes('.lambda-url.')
}

function toPathname(path: string, decoded: boolean): `/${string}` {
  const encoded = path.replace(
    decoded ? DECODED_PATH_UNENCODED_CHAR_RE : UNENCODED_PATH_CHAR_RE,
    safeEncodeURIComponent,
  )

  return encoded.startsWith('/') ? (encoded as `/${string}`) : `/${encoded}`
}
