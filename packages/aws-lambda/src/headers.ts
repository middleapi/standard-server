import type { StandardHeaders } from '@standard-server/core'
import type { AnyAPIGatewayProxyEvent } from './types'
import { toArray } from '@standard-server/shared'

/**
 * Convert API Gateway proxy event headers to standard headers.
 *
 * Payload format 1.0 merges `multiValueHeaders` and `headers`, preferring
 * `multiValueHeaders` per key. Payload format 2.0 restores the `cookie`
 * header from `cookies`.
 */
export function toStandardHeaders(event: AnyAPIGatewayProxyEvent): StandardHeaders {
  const standardHeaders: StandardHeaders = Object.create(null)

  const append = (key: string, values: string[]) => {
    const lowerKey = key.toLowerCase()
    const existing = standardHeaders[lowerKey]

    const merged = existing === undefined ? values : [...toArray(existing), ...values]
    standardHeaders[lowerKey] = merged.length === 1 ? merged[0] : merged
  }

  if (!('httpMethod' in event)) {
    if (event.headers) {
      for (const key of Object.keys(event.headers)) {
        const value = event.headers[key]
        if (value !== undefined) {
          append(key, [value])
        }
      }
    }

    if (event.cookies?.length && standardHeaders.cookie === undefined) {
      append('cookie', [event.cookies.join('; ')])
    }

    return standardHeaders
  }

  if (event.multiValueHeaders) {
    for (const key of Object.keys(event.multiValueHeaders)) {
      const values = event.multiValueHeaders[key]
      if (values !== undefined && values.length !== 0) {
        append(key, values)
      }
    }
  }

  if (event.headers) {
    for (const key of Object.keys(event.headers)) {
      const value = event.headers[key]
      // `multiValueHeaders` is a superset of `headers` in real events,
      // only fill in keys it does not already carry
      if (value !== undefined && standardHeaders[key.toLowerCase()] === undefined) {
        append(key, [value])
      }
    }
  }

  return standardHeaders
}

/**
 * Split standard headers into the `headers` and `cookies` metadata fields.
 * `set-cookie` values are kept separate because joining them would corrupt them.
 */
export function toLambdaHeaders(standardHeaders: StandardHeaders): [
  headers: Record<string, string>,
  setCookies: string[],
] {
  const headers: Record<string, string> = Object.create(null)
  const setCookies: string[] = []

  for (const key of Object.keys(standardHeaders)) {
    const value = standardHeaders[key]
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      continue
    }

    if (key.toLowerCase() === 'set-cookie') {
      setCookies.push(...toArray(value))
    }
    else {
      headers[key] = Array.isArray(value) ? value.join(', ') : value
    }
  }

  return [headers, setCookies]
}
