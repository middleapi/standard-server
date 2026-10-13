import { safeDecodeURIComponent, safeEncodeURIComponent } from './uri'

describe('safeEncodeURIComponent', () => {
  it('encodes like encodeURIComponent for well-formed input', () => {
    expect(safeEncodeURIComponent('test')).toBe('test')
    expect(safeEncodeURIComponent('test value&=#')).toBe('test%20value%26%3D%23')
    expect(safeEncodeURIComponent('λ世界😀')).toBe('%CE%BB%E4%B8%96%E7%95%8C%F0%9F%98%80')
    expect(safeEncodeURIComponent('')).toBe('')
  })

  it('replaces lone surrogates with U+FFFD instead of throwing', () => {
    // encodeURIComponent throws URIError on lone surrogates
    expect(safeEncodeURIComponent('\uD800')).toBe('%EF%BF%BD')
    expect(safeEncodeURIComponent('\uDC00')).toBe('%EF%BF%BD')
    expect(safeEncodeURIComponent('a\uD800b\uDFFFc')).toBe('a%EF%BF%BDb%EF%BF%BDc')
    // a reversed pair is two lone surrogates, not a code point
    expect(safeEncodeURIComponent('\uDC00\uD800')).toBe('%EF%BF%BD%EF%BF%BD')
    // a well-formed pair next to a lone surrogate is kept intact
    expect(safeEncodeURIComponent('😀\uD83D')).toBe('%F0%9F%98%80%EF%BF%BD')
    expect(safeEncodeURIComponent('\u{1F600}\uDE00')).toBe('%F0%9F%98%80%EF%BF%BD')
    expect(safeEncodeURIComponent('\u{10FFFF}\uD800')).toBe('%F4%8F%BF%BF%EF%BF%BD')
    expect(safeEncodeURIComponent('\uD800\u{10000}\uDFFF')).toBe('%EF%BF%BD%F0%90%80%80%EF%BF%BD')
  })
})

describe('safeDecodeURIComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('decodes like decodeURIComponent for well-formed input', () => {
    expect(safeDecodeURIComponent('test')).toBe('test')
    expect(safeDecodeURIComponent('test%20value')).toBe('test value')
    expect(safeDecodeURIComponent('%CE%BB%E4%B8%96%E7%95%8C')).toBe('λ世界')
    expect(safeDecodeURIComponent('%f0%9f%98%80')).toBe('😀')
    expect(safeDecodeURIComponent('')).toBe('')
  })

  it('returns a value that fails to decode as-is instead of throwing', () => {
    expect(safeDecodeURIComponent('invalid%20value%')).toBe('invalid%20value%')
    expect(safeDecodeURIComponent('%ZZ')).toBe('%ZZ')
    // malformed UTF-8: truncated, overlong, surrogate, above U+10FFFF
    expect(safeDecodeURIComponent('%E4%B8')).toBe('%E4%B8')
    expect(safeDecodeURIComponent('%C0%AF')).toBe('%C0%AF')
    expect(safeDecodeURIComponent('%ED%A0%80')).toBe('%ED%A0%80')
    expect(safeDecodeURIComponent('%F4%90%80%80')).toBe('%F4%90%80%80')
    // one malformed escape keeps the valid ones encoded too
    expect(safeDecodeURIComponent('%E4%B8%AD%ZZ')).toBe('%E4%B8%AD%ZZ')
    expect(safeDecodeURIComponent('%FF-%E2%82%AC')).toBe('%FF-%E2%82%AC')
  })

  it('tries decodeURIComponent once on hostile input', () => {
    const decodeSpy = vi.spyOn(globalThis, 'decodeURIComponent')
    const hostile = '%FFa'.repeat(250_000) // ~1 MB

    expect(safeDecodeURIComponent(hostile)).toBe(hostile)
    // not retried in parts, which would throw once per malformed escape
    expect(decodeSpy).toHaveBeenCalledTimes(1)
  })
})
