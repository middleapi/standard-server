import type { StandardUrl } from '@standard-server/core'
import type { AnyAPIGatewayProxyEvent } from './types'

/**
 * Build a standard url from an API Gateway proxy event.
 *
 * Payload format 1.0 query parameters are re-encoded (delivered url-decoded),
 * payload format 2.0's `rawQueryString` is used as-is.
 */
export function toStandardUrl(event: AnyAPIGatewayProxyEvent): StandardUrl {
  if (!('httpMethod' in event)) {
    const pathname = `${event.rawPath.startsWith('/') ? '' : '/'}${event.rawPath}` as `/${string}`

    return event.rawQueryString ? `${pathname}?${event.rawQueryString}` : pathname
  }

  const pathname = `${event.path.startsWith('/') ? '' : '/'}${event.path}` as `/${string}`

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
