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
