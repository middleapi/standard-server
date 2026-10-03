import { stringifyJSON } from '@standard-server/shared'

const SIZE_1KB = 1024
const SIZE_10KB = 10 * SIZE_1KB

/** Simple JSON unit. */
function createUnit(i: number) {
  return {
    id: i,
    name: `item-${i}`,
    active: true,
    score: 42.5,
    tags: ['a', 'b', 'c'],
    meta: { version: '2.0.0', count: i, region: 'us-east-1' },
    profile: {
      name: `user-${i}`,
      email: `user-${i}@example.com`,
      bio: 'hello world',
    },
  }
}

/** Pad a JSON value so `stringifyJSON` length equals `size`. */
function padJson(value: object, size: number): object {
  const base = stringifyJSON({ ...value, _pad: '' })!.length
  if (base > size) throw new Error(`json core ${base} > ${size}`)
  return { ...value, _pad: 'x'.repeat(size - base) }
}

const PAYLOAD_UNIT = createUnit(0)

export const JSON_10KB = padJson(
  { items: Array.from({ length: 10 }, (_, i) => createUnit(i)) },
  SIZE_10KB,
)

function splitBytes(size: number, parts: number): Uint8Array<ArrayBuffer>[] {
  const buf = new Uint8Array(size) as Uint8Array<ArrayBuffer>
  const base = Math.floor(size / parts)
  let rem = size - base * parts
  const out: Uint8Array<ArrayBuffer>[] = []
  let off = 0
  for (let i = 0; i < parts; i++) {
    const n = base + (rem-- > 0 ? 1 : 0)
    out.push(buf.subarray(off, off + n) as Uint8Array<ArrayBuffer>)
    off += n
  }
  return out
}

export const BYTES_10KB = splitBytes(SIZE_10KB, 10)

export const BLOB_10KB = new Blob([new Uint8Array(SIZE_10KB)], { type: 'application/octet-stream' })

function formContentSize(form: FormData): number {
  let n = 0
  const enc = new TextEncoder()
  for (const v of form.values()) n += typeof v === 'string' ? enc.encode(v).byteLength : v.size
  return n
}

export const FORM_10KB = new FormData()
FORM_10KB.append('userId', 'user_0')
FORM_10KB.append('action', 'create')
FORM_10KB.append('meta', stringifyJSON({ tags: ['a', 'b'], dryRun: false })!)
FORM_10KB.append('note', 'hello world')
{
  const fileSize = SIZE_10KB - formContentSize(FORM_10KB)
  if (fileSize <= 0) throw new Error(`form core >= ${SIZE_10KB}`)
  FORM_10KB.append(
    'file',
    new File([new Uint8Array(fileSize)], 'data.bin', { type: 'application/octet-stream' }),
  )
}

export const USP_10KB = new URLSearchParams({
  'page': '1',
  'sort': 'created_at',
  'q': 'search',
  'filter[status]': 'active',
  'data': '',
})
{
  const base = USP_10KB.toString().length
  USP_10KB.set('data', 'x'.repeat(SIZE_10KB - base))
  const d = SIZE_10KB - USP_10KB.toString().length
  if (d) USP_10KB.set('data', (USP_10KB.get('data') ?? '') + 'x'.repeat(d))
}

/** Events totaling 10KB of stringified JSON. */
function makeEvents(size: number): object[] {
  const parts: object[] = [PAYLOAD_UNIT, PAYLOAD_UNIT, PAYLOAD_UNIT, { type: 'pad', text: '' }]
  const core = parts.slice(0, -1).reduce((n, p) => n + stringifyJSON(p)!.length, 0)
  const padBase = stringifyJSON({ type: 'pad', text: '' })!.length
  if (core + padBase > size) throw new Error(`event core ${core + padBase} > ${size}`)
  parts[parts.length - 1] = { type: 'pad', text: 'x'.repeat(size - core - padBase) }
  return parts
}

export const EVENTS_10KB = makeEvents(SIZE_10KB)

/** Fresh async generator over prebuilt event parts (one-shot per call). */
export function asAsyncIteratorObject(
  parts: readonly unknown[],
): AsyncGenerator<unknown, void, undefined> {
  return (async function* () {
    for (const part of parts) yield part
  })()
}

/** Fresh ReadableStream over prebuilt octet chunks (one-shot per call). */
export function asReadableStream(
  parts: readonly Uint8Array<ArrayBuffer>[],
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= parts.length) controller.close()
      else controller.enqueue(parts[i++]!)
    },
  })
}
