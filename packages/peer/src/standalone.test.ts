import { toStandaloneValue, toStandaloneView } from './standalone'

function expectStandaloneBuffer(value: unknown, text: string): void {
  expect(value).toBeInstanceOf(Buffer)
  expect((value as Buffer).buffer.byteLength).toBe((value as Buffer).byteLength)
  expect((value as Buffer).toString()).toBe(text)
}

describe('toStandaloneView', () => {
  it('copies a view of part of a larger buffer, keeping its type', () => {
    const pooled = Buffer.from('hi')
    expect(pooled.buffer.byteLength).toBeGreaterThan(pooled.byteLength) // Node's shared Buffer pool
    expectStandaloneBuffer(toStandaloneView(pooled), 'hi')
    expect(pooled.buffer.byteLength).toBeGreaterThan(pooled.byteLength)

    const ints = toStandaloneView(new Int32Array(new ArrayBuffer(16), 4, 2).fill(7))
    expect(ints).toBeInstanceOf(Int32Array)
    expect(ints.buffer.byteLength).toBe(8)
    expect([...ints]).toEqual([7, 7])

    const view = toStandaloneView(new DataView(new Uint8Array([0, 1, 2, 3, 4, 5]).buffer, 2, 3))
    expect(view).toBeInstanceOf(DataView)
    expect(view.buffer.byteLength).toBe(3)
    expect(view.getUint8(0)).toBe(2)
  })

  it('returns a view of its whole buffer as-is', () => {
    const whole = new Uint8Array([1, 2, 3])
    expect(toStandaloneView(whole)).toBe(whole)
  })
})

describe('toStandaloneValue', () => {
  it('copies partial views at the top level or nested in arrays and plain objects', () => {
    expectStandaloneBuffer(toStandaloneValue(Buffer.from('top')), 'top')

    const a = Buffer.from('a')
    const b = Buffer.from('b')
    const value = { a, list: [1, { b }], keep: { n: 1 } }

    const copied = toStandaloneValue(value)

    expectStandaloneBuffer(copied.a, 'a')
    expectStandaloneBuffer((copied.list[1] as { b: Buffer }).b, 'b')
    expect(copied.keep).toBe(value.keep) // containers without partial views are reused
    // the input is left untouched
    expect(value.a).toBe(a)
    expect((value.list[1] as { b: Buffer }).b).toBe(b)
  })

  it('returns values without partial views by identity and does not walk other containers', () => {
    expect(toStandaloneValue(undefined)).toBe(undefined)
    expect(toStandaloneValue('text')).toBe('text')

    const value = { list: [new Uint8Array([1])], map: new Map([['e', Buffer.from('e')]]) }
    expect(toStandaloneValue(value)).toBe(value)
  })

  it('keeps an own __proto__ key as data when copying', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"plain":{}}')
    value.plain.file = Buffer.from('p')

    const copied = toStandaloneValue(value)

    expect(copied).not.toBe(value)
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype)
    expect(Object.keys(copied)).toEqual(['__proto__', 'plain'])
    expect(copied.polluted).toBe(undefined)
    expectStandaloneBuffer(copied.plain.file, 'p')
  })

  it('copies null-prototype objects and shared references once', () => {
    const shared = Object.assign(Object.create(null), { file: Buffer.from('s') })

    const copied = toStandaloneValue({ first: shared, second: [shared] })

    expect(copied.first).not.toBe(shared)
    expect(Object.getPrototypeOf(copied.first)).toBe(null)
    expectStandaloneBuffer(copied.first.file, 's')
    expect(copied.second[0]).toBe(copied.first)
  })

  it('copies partial views in cyclic values without hanging', () => {
    const cyclic: any = { list: [] }
    cyclic.list.push(cyclic, { self: cyclic })
    cyclic.file = Buffer.from('c')

    const copied = toStandaloneValue(cyclic)

    expect(copied).not.toBe(cyclic)
    expectStandaloneBuffer(copied.file, 'c')
    // back-references point at the copy, not at the original that still holds the pooled view
    expect(copied.list[0]).toBe(copied)
    expect(copied.list[1].self).toBe(copied)
    expect(cyclic.list[0]).toBe(cyclic)

    // a back-reference copies the containers on the cycle, even without partial views
    const clean: any = { n: 1 }
    clean.self = clean
    expect(toStandaloneValue(clean)).toEqual(clean)
  })
})
