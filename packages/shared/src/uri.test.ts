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
  })
})

describe('safeDecodeURIComponent', () => {
  it('decodes like decodeURIComponent for well-formed input', () => {
    expect(safeDecodeURIComponent('test')).toBe('test')
    expect(safeDecodeURIComponent('test%20value')).toBe('test value')
    expect(safeDecodeURIComponent('%CE%BB%E4%B8%96%E7%95%8C')).toBe('λ世界')
    expect(safeDecodeURIComponent('')).toBe('')
  })

  it('decodes every valid UTF-8 sequence', () => {
    let chars = ''
    for (let codePoint = 0; codePoint <= 0x10FFFF; codePoint++) {
      if (codePoint < 0xD800 || codePoint > 0xDFFF) {
        chars += String.fromCodePoint(codePoint)
      }
    }

    expect(safeDecodeURIComponent(safeEncodeURIComponent(chars))).toBe(chars)
  })

  it('keeps malformed and non-UTF-8 escapes as-is instead of throwing', () => {
    expect(safeDecodeURIComponent('invalid%20value%')).toBe('invalid value%')
    expect(safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A') // Invalid UTF-8 sequence
    expect(safeDecodeURIComponent('%ZZ')).toBe('%ZZ')
    expect(safeDecodeURIComponent('%ZZ%e4%b8%ad%')).toBe('%ZZ中%')
    expect(safeDecodeURIComponent('%FF-%E2%82%AC')).toBe('%FF-€')
    expect(safeDecodeURIComponent('%E4%B8%AD%FF%E4%B8')).toBe('中%FF%E4%B8')
    // decoded output is not decoded again
    expect(safeDecodeURIComponent('%2541%ZZ')).toBe('%41%ZZ')

    // overlong, surrogate, out-of-range and lone continuation sequences are not valid UTF-8
    for (const escapes of ['%C1%BF', '%E0%9F%BF', '%ED%A0%80', '%F0%8F%BF%BF', '%F4%90%80%80', '%F5%80%80%80', '%80']) {
      expect(safeDecodeURIComponent(escapes)).toBe(escapes)
    }
  })
})
