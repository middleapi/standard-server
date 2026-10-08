import { escapeSchemeRelativePath, safeDecodeURIComponent, safeEncodeURIComponent } from './uri'

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

  it('keeps malformed escapes as-is and still decodes the valid ones instead of throwing', () => {
    expect(safeDecodeURIComponent('invalid%20value%')).toBe('invalid value%')
    expect(safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A') // Invalid UTF-8 sequence
    expect(safeDecodeURIComponent('%ZZ')).toBe('%ZZ')
    expect(safeDecodeURIComponent('%ZZ%e4%b8%ad%')).toBe('%ZZ中%')
    expect(safeDecodeURIComponent('%FF-%E2%82%AC')).toBe('%FF-€')
    // a run of escapes that is not valid UTF-8 is kept as a whole
    expect(safeDecodeURIComponent('%E4%B8%AD%FF%')).toBe('%E4%B8%AD%FF%')
    // decoded output is not decoded again
    expect(safeDecodeURIComponent('%2541%ZZ')).toBe('%41%ZZ')
  })
})

describe('escapeSchemeRelativePath', () => {
  it('keeps paths `URL` resolves against the base as-is', () => {
    for (const path of [
      '/',
      '/x',
      '/x//y',
      '/x/\\y',
      '/%2Fx',
      '/%5Cx',
      '/.//x',
      '/?//x',
      '/#//x',
      '/\t',
    ] as const) {
      expect(escapeSchemeRelativePath(path)).toBe(path)
    }
  })

  it('encodes what follows the leading slash when `URL` would read a host', () => {
    expect(escapeSchemeRelativePath('//evil.com/admin?x=1')).toBe('/%2Fevil.com/admin?x=1')
    expect(escapeSchemeRelativePath('///evil.com/admin')).toBe('/%2F/evil.com/admin')
    expect(escapeSchemeRelativePath('//')).toBe('/%2F')
    expect(escapeSchemeRelativePath('/\\evil.com/admin')).toBe('/%5Cevil.com/admin')
    // `URL` strips tabs and newlines before parsing
    expect(escapeSchemeRelativePath('/\t\r\n/evil.com/admin')).toBe('/%09%0D%0A%2Fevil.com/admin')
  })

  it('resolves against the base without losing the path', () => {
    for (const path of [
      '//evil.com/admin',
      '///evil.com',
      '/\\evil.com',
      '/\t/evil.com',
    ] as const) {
      expect(new URL(path, 'http://localhost').host).toBe('evil.com')

      const escaped = escapeSchemeRelativePath(path)
      const url = new URL(escaped, 'http://localhost')
      expect(url.host).toBe('localhost')
      expect(url.pathname).toBe(escaped)
      expect(safeDecodeURIComponent(url.pathname)).toBe(path)
    }
  })
})
