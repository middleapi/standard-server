// `bench` titles name the APIs under test (`Object.keys()`, `Object.entries()`),
// so they keep the capitalisation those APIs actually have.
/* eslint-disable test/prefer-lowercase-title */
import { bench, describe } from 'vitest'

/**
 * `for...in` vs `Object.keys()` vs `Object.entries()`.
 *
 * The adapters iterate header and query objects on every request, so the shapes
 * here mirror what they actually see: small string-to-string objects, sometimes
 * with a null prototype (`Object.create(null)`, as the header converters build).
 *
 * The dominant variable is not the key count, it is whether V8 keeps the object
 * in *fast* (hidden-class) properties or demotes it to *dictionary* properties.
 * `for...in` has a fast path backed by the map's enum cache that only applies to
 * the former, so the ranking flips between the two modes. The shapes below cover
 * both deliberately; each one's mode was verified with
 * `node --allow-natives-syntax -e '%HasFastProperties(object)'`:
 *
 * - `Object.create(null)` is dictionary-mode from birth, at any size.
 * - Spread, `Object.assign`, `Object.fromEntries` and `JSON.parse` pre-size the
 *   object, so it stays fast-mode at sizes well past what a `{}` survives.
 * - A `{}` filled one key at a time is demoted at the 20th key — but only until
 *   something builds a fast map for that same key sequence, after which the
 *   incremental build follows the existing transitions and stays fast. That
 *   makes size a fragile way to ask for a dictionary-mode object, so the
 *   dictionary shapes below use `Object.create(null)` and do not depend on the
 *   order the module happens to evaluate in.
 *
 * Methodology notes:
 *
 * - Every loop body does the same observable work (`key.length + value.length`)
 *   so the numbers reflect iteration plus property access, not the body. A
 *   `for...in`/`Object.keys()` loop has to look the value up; `Object.entries()`
 *   is handed it. That asymmetry is the trade-off being measured.
 * - The loops are written inline in each `bench()` rather than extracted into
 *   shared helpers. A shared helper called with every shape in this file would
 *   go megamorphic after warmup and report times no real call site would see.
 *   Each `bench()` callback is its own function, so its inline caches stay as
 *   monomorphic as the equivalent call site in `packages/`.
 * - Totals accumulate into an exported binding so V8 cannot treat the loops as
 *   dead code.
 */

/** Written by every loop; exported so the accumulation is observable. */
export const sink = { total: 0 }

const HEADER_NAMES = [
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'user-agent',
  'authorization',
  'cookie',
  'host',
  'referer',
  'origin',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-request-id',
  'cache-control',
  'connection',
]

const HEADER_VALUES = [
  'application/json',
  '1024',
  '*/*',
  'gzip, deflate, br',
  'Mozilla/5.0 (X11; Linux x86_64)',
  'Bearer abcdef0123456789',
  'session=abcdef0123456789; theme=dark',
  'example.com',
]

/**
 * A string-to-string object of `size` keys, shaped like real headers.
 *
 * `nullPrototype` is how the shapes below ask for dictionary-mode properties;
 * callers that want a large fast-mode object spread the result to re-pack it.
 */
function createHeaders(size: number, nullPrototype = false): Record<string, string> {
  const object: Record<string, string> = nullPrototype ? Object.create(null) : {}

  for (let i = 0; i < size; i++) {
    const key = i < HEADER_NAMES.length ? HEADER_NAMES[i]! : `x-custom-header-${i}`
    object[key] = HEADER_VALUES[i % HEADER_VALUES.length]!
  }

  return object
}

const FAST_3 = createHeaders(3)
const FAST_8 = createHeaders(8)
/** Spread re-packs the demoted 50-key object back into fast properties. */
const FAST_50 = { ...createHeaders(50) }
/** What `toStandardHeaders` hands the rest of the pipeline. */
const DICT_8 = createHeaders(8, true)
const DICT_50 = createHeaders(50, true)

/**
 * Eight keys each and fast-mode, but every object has a different key set and
 * therefore a different hidden class, so one loop sees twelve maps — the state a
 * shared helper in `packages/` ends up in. Dictionary-mode objects would not
 * show this: they share one slow map, which is why this block is fast-mode only.
 */
const MEGAMORPHIC = Array.from({ length: 12 }, (_, shape) => {
  const object: Record<string, string> = {}

  for (let i = 0; i < 8; i++) {
    object[`x-shape-${shape}-${i}`] = HEADER_VALUES[i % HEADER_VALUES.length]!
  }

  return object
})

const shapes = [
  ['fast-mode object, 3 keys', FAST_3],
  ['fast-mode object, 8 keys', FAST_8],
  ['fast-mode object, 50 keys', FAST_50],
  ['dictionary-mode object, 8 keys (null prototype)', DICT_8],
  ['dictionary-mode object, 50 keys (null prototype)', DICT_50],
] as const

describe.each(shapes)('iterate %s', (_, object) => {
  bench('for...in', () => {
    let total = 0
    for (const key in object) {
      const value = object[key]
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })

  bench('for...in + Object.hasOwn', () => {
    let total = 0
    for (const key in object) {
      if (!Object.hasOwn(object, key)) {
        continue
      }
      const value = object[key]
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })

  bench('Object.keys() + for...of', () => {
    let total = 0
    for (const key of Object.keys(object)) {
      const value = object[key]
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })

  bench('Object.keys() + indexed for', () => {
    let total = 0
    const keys = Object.keys(object)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!
      const value = object[key]
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })

  bench('Object.entries() + for...of', () => {
    let total = 0
    for (const [key, value] of Object.entries(object)) {
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })

  bench('Object.entries() + indexed for', () => {
    let total = 0
    const entries = Object.entries(object)
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i]!
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })
})

describe('iterate fast-mode objects, 8 keys, 12 hidden classes (megamorphic)', () => {
  let cursor = 0
  const next = () => MEGAMORPHIC[cursor++ % MEGAMORPHIC.length]!

  bench('for...in', () => {
    const object = next()
    let total = 0
    for (const key in object) {
      const value = object[key]
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })

  bench('for...in + Object.hasOwn', () => {
    const object = next()
    let total = 0
    for (const key in object) {
      if (!Object.hasOwn(object, key)) {
        continue
      }
      const value = object[key]
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })

  bench('Object.keys() + for...of', () => {
    const object = next()
    let total = 0
    for (const key of Object.keys(object)) {
      const value = object[key]
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })

  bench('Object.keys() + indexed for', () => {
    const object = next()
    let total = 0
    const keys = Object.keys(object)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!
      const value = object[key]
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })

  bench('Object.entries() + for...of', () => {
    const object = next()
    let total = 0
    for (const [key, value] of Object.entries(object)) {
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })

  bench('Object.entries() + indexed for', () => {
    const object = next()
    let total = 0
    const entries = Object.entries(object)
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i]!
      if (value !== undefined) {
        total += key.length + value.length
      }
    }
    sink.total += total
  })
})

/**
 * The same three strategies doing the work an adapter actually does — read a
 * null-prototype headers object and rebuild one — so the iteration cost is
 * measured against the allocation and string work that surrounds it in practice.
 */
describe('rebuild a headers object, 8 keys, dictionary-mode input', () => {
  bench('for...in', () => {
    const headers: Record<string, string> = Object.create(null)
    for (const key in DICT_8) {
      const value = DICT_8[key]
      if (value !== undefined) {
        headers[key.toLowerCase()] = value
      }
    }
    sink.total += headers.host === undefined ? 0 : 1
  })

  bench('Object.keys() + for...of', () => {
    const headers: Record<string, string> = Object.create(null)
    for (const key of Object.keys(DICT_8)) {
      const value = DICT_8[key]
      if (value !== undefined) {
        headers[key.toLowerCase()] = value
      }
    }
    sink.total += headers.host === undefined ? 0 : 1
  })

  bench('Object.entries() + for...of', () => {
    const headers: Record<string, string> = Object.create(null)
    for (const [key, value] of Object.entries(DICT_8)) {
      if (value !== undefined) {
        headers[key.toLowerCase()] = value
      }
    }
    sink.total += headers.host === undefined ? 0 : 1
  })
})
