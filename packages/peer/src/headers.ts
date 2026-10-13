import type { StandardHeaders } from '@standard-server/core'

/**
 * Normalize headers received from the remote peer to lowercase keys, like the other adapters do.
 *
 * Keys that differ only by case are merged in order. Without a collision the value is kept
 * as is, so `content-type: []` still marks a streamed body. `undefined` values are dropped.
 */
export function toStandardHeaders(raw: StandardHeaders | undefined): StandardHeaders {
  // Group first, so merging many case variants of one name stays linear
  const groups = new Map<string, (string | string[])[]>()

  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined) {
      continue
    }

    const lowerKey = key.toLowerCase()
    const group = groups.get(lowerKey)

    if (group) {
      group.push(value)
    } else {
      groups.set(lowerKey, [value])
    }
  }

  // Null prototype so header names like __proto__ become plain own
  // properties instead of touching the object's prototype.
  const standardHeaders: StandardHeaders = Object.create(null)

  for (const [key, values] of groups) {
    standardHeaders[key] = values.length === 1 ? values[0] : values.flat()
  }

  return standardHeaders
}
