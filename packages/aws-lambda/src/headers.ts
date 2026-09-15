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
      for (const [key, value] of Object.entries(event.headers)) {
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
    for (const [key, values] of Object.entries(event.multiValueHeaders)) {
      if (values !== undefined && values.length !== 0) {
        append(key, values)
      }
    }
  }

  if (event.headers) {
    for (const [key, value] of Object.entries(event.headers)) {
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
 * Read a single header from an API Gateway proxy event, case-insensitively.
 */
export function getEventHeader(event: AnyAPIGatewayProxyEvent, key: string): string | string[] | undefined {
  key = key.toLowerCase()

  if ('httpMethod' in event && event.multiValueHeaders) {
    for (const [k, headerValues] of Object.entries(event.multiValueHeaders)) {
      if (headerValues !== undefined && headerValues.length !== 0 && k.toLowerCase() === key) {
        return headerValues
      }
    }
  }

  if (event.headers) {
    for (const [k, headerValue] of Object.entries(event.headers)) {
      if (headerValue !== undefined && k.toLowerCase() === key) {
        return headerValue
      }
    }
  }

  if (key === 'cookie' && !('httpMethod' in event) && event.cookies?.length) {
    return event.cookies.join('; ')
  }

  return undefined
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

  for (const [key, value] of Object.entries(standardHeaders)) {
    if (value === undefined) {
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
