import { toStandardUrl } from './url'

it('toStandardUrl', () => {
  expect(toStandardUrl(new URL('http://localhost:3000/'))).toBe('/')
  expect(toStandardUrl(new URL('http://localhost:3000/path?param=value#hash'))).toBe(
    '/path?param=value#hash',
  )

  const url = new URL('http://localhost:3000/path?param=value#hash')
  url.searchParams.set('!@#$', '%^&%^')
  url.pathname = '/?'
  url.hash = '#/#hash'
  expect(toStandardUrl(url)).toBe('/%3F?param=value&%21%40%23%24=%25%5E%26%25%5E#/#hash')
})

it('toStandardUrl escapes a pathname `new URL(url, base)` would read as a host', () => {
  // `\` is a path separator in http(s) urls, `/..` is resolved before the pathname is read
  for (const href of [
    'http://localhost:3000//evil.com/admin/x?param=value#hash',
    'http://localhost:3000/\\evil.com/admin/x?param=value#hash',
    'http://localhost:3000/..//evil.com/admin/x?param=value#hash',
  ]) {
    const standardUrl = toStandardUrl(new URL(href))
    expect(standardUrl).toBe('/%2Fevil.com/admin/x?param=value#hash')

    const resolved = new URL(standardUrl, 'http://localhost')
    expect(resolved.host).toBe('localhost')
    expect(resolved.pathname).toBe('/%2Fevil.com/admin/x')
  }

  expect(toStandardUrl(new URL('http://localhost:3000///'))).toBe('/%2F/')
  // non-special schemes keep `\` in the pathname
  expect(toStandardUrl(new URL('foo://localhost/\\evil.com/x'))).toBe('/%5Cevil.com/x')
  // only the start of the pathname matters
  expect(toStandardUrl(new URL('http://localhost:3000/path//x?next=//evil.com'))).toBe(
    '/path//x?next=//evil.com',
  )
})
