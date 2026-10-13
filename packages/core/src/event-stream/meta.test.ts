import {
  getEventMeta,
  unwrapEvent,
  unwrapEventForEmit,
  withEventMeta,
  withReceivedEventMeta,
} from './meta'

it('get/withEventMeta', () => {
  const data = { value: 123, meta: undefined }
  const applied = withEventMeta(data, { id: '123', retry: 10000, comments: ['hello', 'world'] })
  expect(applied).toEqual(data)
  expect(applied).not.toBe(data)
  expect(getEventMeta(applied)).toEqual({ id: '123', retry: 10000, comments: ['hello', 'world'] })
  expect(getEventMeta(data)).toEqual(undefined)
  expect(getEventMeta(1)).toEqual(undefined)

  expect(() => withEventMeta(data, { id: '123\n' })).toThrow(
    "Event's id must not contain a carriage return, newline or NULL character",
  )
  expect(() => withEventMeta(data, { id: '123\r' })).toThrow(
    "Event's id must not contain a carriage return, newline or NULL character",
  )
  expect(() => withEventMeta(data, { id: '123\0' })).toThrow(
    "Event's id must not contain a carriage return, newline or NULL character",
  )
  expect(() => withEventMeta(data, { retry: Number.NaN })).toThrow(
    "Event's retry must be a integer and >= 0",
  )
  expect(() => withEventMeta(data, { retry: 1.1 })).toThrow(
    "Event's retry must be a integer and >= 0",
  )
  expect(() => withEventMeta(data, { retry: -1 })).toThrow(
    "Event's retry must be a integer and >= 0",
  )
  expect(() => withEventMeta(data, { comments: ['hi\n'] })).toThrow(
    "Event's comment must not contain a carriage return or newline character",
  )
  expect(() => withEventMeta(data, { comments: ['hi\r'] })).toThrow(
    "Event's comment must not contain a carriage return or newline character",
  )
})

it('withEventMeta only proxy when make sense', () => {
  const data = { value: 123, meta: undefined }

  expect(withEventMeta(data, { id: '123', retry: 10000, comments: ['hello', 'world'] })).not.toBe(
    data,
  )
  expect(withEventMeta(data, { id: '' })).not.toBe(data)
  expect(withEventMeta(data, { retry: 0 })).not.toBe(data)
  expect(withEventMeta(data, { comments: [''] })).not.toBe(data)
  expect(withEventMeta(data, { comments: [] })).not.toBe(data)

  expect(withEventMeta(data, {})).toBe(data)
  expect(withEventMeta(data, { notExists: true } as any)).toBe(data)
  expect(withEventMeta(data, { id: undefined })).toBe(data)
})

it('withEventMeta keeps the container visible shape', () => {
  const data = { value: 123 }
  const applied = withEventMeta(data, { id: '123' })
  expect(applied.constructor).toBe(Object)
  expect(applied).toStrictEqual({ value: 123 })

  class Foo {
    static bar = 'bar'
    #value = 123
    getValue() {
      return this.#value
    }
  }
  const foo = withEventMeta(new Foo(), { id: '123' })
  expect(foo.constructor).toBe(Foo)
  expect((foo.constructor as typeof Foo).bar).toBe('bar')
  expect(foo).toBeInstanceOf(Foo)
  expect(foo.getValue()).toBe(123)

  const map = withEventMeta(new Map([['key', 'value']]), { id: '123' })
  expect(map.constructor).toBe(Map)
  expect(map.get('key')).toBe('value')
  expect(map.size).toBe(1)
})

it('getEventMeta remove unknown meta', () => {
  const data = { value: 123, meta: undefined }
  const meta = { id: '123', unknown: 'value1' }
  const applied = withEventMeta(data, meta)
  expect(getEventMeta(applied)).toEqual({ id: '123' })
})

describe('unwrapEvent', () => {
  it('non-object', () => {
    expect(unwrapEvent(1)).toEqual([1, undefined])
    expect(unwrapEvent('1')).toEqual(['1', undefined])
    expect(unwrapEvent(true)).toEqual([true, undefined])
    expect(unwrapEvent(null)).toEqual([null, undefined])
    expect(unwrapEvent(undefined)).toEqual([undefined, undefined])
  })

  it('object without events', () => {
    const data = { value: 123, meta: undefined }
    const [resolvedData, resolvedMeta] = unwrapEvent(data)
    expect(resolvedData).toBe(data)
    expect(resolvedMeta).toBe(undefined)
  })

  it('object with events', () => {
    const data = { value: 123, meta: undefined }
    const meta = { id: '123' }
    const applied = withEventMeta(data, meta)
    const [resolvedData, resolvedMeta] = unwrapEvent(applied)
    expect(resolvedData).toBe(data)
    expect(resolvedMeta).toEqual(meta)
  })
})

describe('received event meta', () => {
  const meta = { id: 'x', retry: 99999, comments: ['c'] }

  it('withReceivedEventMeta keeps meta readable', () => {
    const data = { value: 123 }
    const received = withReceivedEventMeta(data, meta)

    expect(received).toEqual(data)
    expect(received).not.toBe(data)
    expect(getEventMeta(received)).toEqual(meta)

    const [resolvedData, resolvedMeta] = unwrapEvent(received)
    expect(resolvedData).toBe(data)
    expect(resolvedMeta).toEqual(meta)
  })

  it('withReceivedEventMeta validates and only proxies when make sense', () => {
    const data = { value: 123 }
    expect(withReceivedEventMeta(data, {})).toBe(data)
    expect(() => withReceivedEventMeta(data, { id: 'x\n' })).toThrow(
      "Event's id must not contain a carriage return, newline or NULL character",
    )
    expect(() => withReceivedEventMeta(data, { retry: -1 })).toThrow(
      "Event's retry must be a integer and >= 0",
    )
  })

  it('unwrapEventForEmit drops received meta', () => {
    const data = { value: 123 }
    expect(unwrapEventForEmit(withReceivedEventMeta(data, meta))).toEqual([data, undefined])

    const error = withReceivedEventMeta(new Error('boom'), meta)
    expect(unwrapEventForEmit(error)[1]).toBe(undefined)
    expect(getEventMeta(error)).toEqual(meta)
  })

  it('unwrapEventForEmit keeps meta attached with withEventMeta', () => {
    const data = { value: 123 }
    expect(unwrapEventForEmit(withEventMeta(data, meta))).toEqual([data, meta])
    expect(unwrapEventForEmit(data)).toEqual([data, undefined])
    expect(unwrapEventForEmit(1)).toEqual([1, undefined])
    expect(unwrapEventForEmit(null)).toEqual([null, undefined])
  })

  it('re-wrapping with withEventMeta forwards or replaces received meta', () => {
    const data = { value: 123 }
    const received = withReceivedEventMeta(data, meta)

    const forwarded = withEventMeta(received, getEventMeta(received)!)
    expect(unwrapEventForEmit(forwarded)).toEqual([data, meta])
    // wraps the original value instead of nesting proxies
    expect(unwrapEvent(forwarded)[0]).toBe(data)

    const replaced = withEventMeta(received, { id: 'server' })
    expect(unwrapEventForEmit(replaced)[1]).toEqual({ id: 'server' })
    expect(unwrapEvent(replaced)[0]).toBe(data)
  })

  it('withEventMeta with empty meta keeps the value received', () => {
    const received = withReceivedEventMeta({ value: 123 }, meta)
    const same = withEventMeta(received, {})
    expect(same).toBe(received)
    expect(unwrapEventForEmit(same)[1]).toBe(undefined)
  })
})
