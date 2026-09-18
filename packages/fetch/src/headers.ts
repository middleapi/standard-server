import type { StandardHeaders } from '@standard-server/core'

/**
 * Convert fetch headers to standard headers.
 */
export function toStandardHeaders(headers: Headers): StandardHeaders {
  // Null prototype so header names like __proto__ become plain own
  // properties instead of touching the object's prototype.
  const standardHeaders: StandardHeaders = Object.create(null)

  headers.forEach((value, key) => {
    if (Array.isArray(standardHeaders[key])) {
      standardHeaders[key].push(value)
    }
    else if (standardHeaders[key] !== undefined) {
      standardHeaders[key] = [standardHeaders[key], value]
    }
    else {
      standardHeaders[key] = value
    }
  })

  return standardHeaders
}

/**
 * Convert standard headers to fetch headers.
 */
export function toFetchHeaders(standardHeaders: StandardHeaders): Headers {
  const headers = new Headers()

  for (const key of Object.keys(standardHeaders)) {
    const value = standardHeaders[key]
    if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v)
      }
    }
    else if (value !== undefined) {
      headers.append(key, value)
    }
  }

  return headers
}
