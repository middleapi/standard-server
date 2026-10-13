import type { StandardHeaders } from '@standard-server/core'
import { toArray } from '@standard-server/shared'

/**
 * Normalize headers received from the remote peer to lowercase keys, like the other adapters do.
 *
 * Keys that differ only by case are merged in order. Without a collision the value is kept
 * as is, so `content-type: []` still marks a streamed body. `undefined` values are dropped.
 */
export function toStandardHeaders(raw: StandardHeaders | undefined): StandardHeaders {
  // Null prototype so header names like __proto__ become plain own
  // properties instead of touching the object's prototype.
  const standardHeaders: StandardHeaders = Object.create(null)

  if (!raw) {
    return standardHeaders
  }

  for (const key of Object.keys(raw)) {
    const value = raw[key]
    if (value === undefined) {
      continue
    }

    const lowerKey = key.toLowerCase()
    const existing = standardHeaders[lowerKey]

    standardHeaders[lowerKey] =
      existing === undefined ? value : [...toArray(existing), ...toArray(value)]
  }

  return standardHeaders
}
