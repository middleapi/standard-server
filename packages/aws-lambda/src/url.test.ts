import { parseStandardUrl } from '@standard-server/core'
import { toStandardUrl } from './url'

describe('toStandardUrl (v2)', () => {
  it('works without query string', () => {
    expect(toStandardUrl({
      rawPath: '/example',
      requestContext: { http: { method: 'GET' } },
    })).toBe('/example')

    expect(toStandardUrl({
      rawPath: '/example',
      rawQueryString: '',
      requestContext: { http: { method: 'GET' } },
    })).toBe('/example')
  })

  it('adds a leading slash when missing', () => {
    expect(toStandardUrl({
      rawPath: 'example',
      requestContext: { http: { method: 'GET' } },
    })).toBe('/example')
  })

  it('uses rawQueryString as-is', () => {
    expect(toStandardUrl({
      rawPath: '/example',
      rawQueryString: 'foo=bar&foo=baz&a+key=a+value%26%3D%23',
      requestContext: { http: { method: 'GET' } },
    })).toBe('/example?foo=bar&foo=baz&a+key=a+value%26%3D%23')
  })

  it('uses the already-encoded rawPath as-is', () => {
    expect(toStandardUrl({
      rawPath: '/users/me%3Fadmin=true%23%2Fnope',
      requestContext: { http: { method: 'GET' } },
    })).toBe('/users/me%3Fadmin=true%23%2Fnope')

    expect(toStandardUrl({
      rawPath: '/caf%C3%A9/a%20b/100%25',
      requestContext: { http: { method: 'GET' } },
    })).toBe('/caf%C3%A9/a%20b/100%25')
  })

  it('escapes a bare delimiter a well-formed rawPath cannot carry', () => {
    // defense in depth: `?` and `#` are always percent-encoded in a real rawPath,
    // so escaping them never double-encodes but stops a stray one reshaping the url
    expect(toStandardUrl({
      rawPath: '/users/me?admin=true',
      requestContext: { http: { method: 'GET' } },
    })).toBe('/users/me%3Fadmin=true')

    expect(toStandardUrl({
      rawPath: '/orders#',
      rawQueryString: 'tenant=acme',
      requestContext: { http: { method: 'GET' } },
    })).toBe('/orders%23?tenant=acme')
  })
})

describe('toStandardUrl (v1)', () => {
  it('works without query string', () => {
    expect(toStandardUrl({ httpMethod: 'GET', path: '/example' })).toBe('/example')
  })

  it('detects v1 by the top-level httpMethod field', () => {
    // a v1 event carries a requestContext too, it must not be mistaken for v2
    expect(toStandardUrl({
      httpMethod: 'GET',
      path: '/example',
      requestContext: {},
      queryStringParameters: { foo: 'bar' },
    } as any)).toBe('/example?foo=bar')
  })

  it('adds a leading slash when missing', () => {
    expect(toStandardUrl({ httpMethod: 'GET', path: 'example' })).toBe('/example')
  })

  it('merges both sources, preferring multiValueQueryStringParameters per key', () => {
    expect(toStandardUrl({
      httpMethod: 'GET',
      path: '/example',
      queryStringParameters: { foo: 'ignored', only: 'kept' },
      multiValueQueryStringParameters: { foo: ['bar', 'baz'], hello: ['world'] },
    })).toBe('/example?foo=bar&foo=baz&hello=world&only=kept')
  })

  it('skips undefined multiValueQueryStringParameters values', () => {
    expect(toStandardUrl({
      httpMethod: 'GET',
      path: '/example',
      multiValueQueryStringParameters: { foo: ['bar'], skipped: undefined },
    })).toBe('/example?foo=bar')
  })

  it('falls back to queryStringParameters', () => {
    expect(toStandardUrl({
      httpMethod: 'GET',
      path: '/example',
      queryStringParameters: { foo: 'bar', empty: '', skipped: undefined },
      multiValueQueryStringParameters: null,
    })).toBe('/example?foo=bar&empty=')
  })

  it('re-encodes decoded query string parameters', () => {
    expect(toStandardUrl({
      httpMethod: 'GET',
      path: '/example',
      multiValueQueryStringParameters: { 'a key': ['a value&=#'] },
    })).toBe(`/example?${new URLSearchParams({ 'a key': 'a value&=#' })}`)
  })

  it('ignores empty query containers', () => {
    expect(toStandardUrl({
      httpMethod: 'GET',
      path: '/example',
      queryStringParameters: null,
      multiValueQueryStringParameters: {},
    })).toBe('/example')
  })
})

// payload format 1.0 delivers `path` url-decoded, so a client can put a `?` or a `#`
// into it with `%3F` / `%23`. Left verbatim they reshape the url a consumer parses
// back out of the StandardUrl string.
describe('toStandardUrl (v1 path re-encoding)', () => {
  it('escapes a decoded `?` instead of opening a query string', () => {
    // wire request: GET /users/me%3Fadmin=true
    const url = toStandardUrl({ httpMethod: 'GET', path: '/users/me?admin=true' })

    expect(url).toBe('/users/me%3Fadmin=true')
    expect(parseStandardUrl(url)).toEqual(['/users/me%3Fadmin=true', undefined, undefined])
  })

  it('escapes a decoded `#` instead of swallowing the real query string', () => {
    // wire request: GET /orders%23?tenant=acme
    const url = toStandardUrl({
      httpMethod: 'GET',
      path: '/orders#',
      multiValueQueryStringParameters: { tenant: ['acme'] },
    })

    expect(url).toBe('/orders%23?tenant=acme')
    expect(parseStandardUrl(url)).toEqual(['/orders%23', '?tenant=acme', undefined])
    expect([...new URLSearchParams(parseStandardUrl(url)[1])]).toEqual([['tenant', 'acme']])
  })

  it('escapes spaces, percents, controls and non-ascii', () => {
    expect(toStandardUrl({ httpMethod: 'GET', path: '/a b' })).toBe('/a%20b')
    expect(toStandardUrl({ httpMethod: 'GET', path: '/100%' })).toBe('/100%25')
    expect(toStandardUrl({ httpMethod: 'GET', path: '/a\u0000b' })).toBe('/a%00b')
    expect(toStandardUrl({ httpMethod: 'GET', path: '/caf\u00E9' })).toBe('/caf%C3%A9')
    expect(toStandardUrl({ httpMethod: 'GET', path: '/a<b>c{d}e`f"g' })).toBe('/a%3Cb%3Ec%7Bd%7De%60f%22g')
  })

  it('escapes an astral code point as a whole', () => {
    expect(toStandardUrl({ httpMethod: 'GET', path: '/\u{1F389}' })).toBe('/%F0%9F%8E%89')
  })

  it('replaces a lone surrogate rather than throwing', () => {
    expect(toStandardUrl({ httpMethod: 'GET', path: '/a\uD800b' })).toBe('/a%EF%BF%BDb')
  })

  it('leaves legal path characters alone so routes keep matching', () => {
    const path = '/users/me:profile@v1/a+b&c=d,e;f/~!$\'()*-._'

    expect(toStandardUrl({ httpMethod: 'GET', path })).toBe(path)
  })

  it('keeps path separators', () => {
    // a percent-encoded `/` is decoded into a real separator by api gateway before
    // the event is built, so the segment boundary is already lost and `/` stays raw
    expect(toStandardUrl({ httpMethod: 'GET', path: '/files/a/b' })).toBe('/files/a/b')
  })

  it('escapes a path missing its leading slash', () => {
    expect(toStandardUrl({ httpMethod: 'GET', path: 'users/me?admin=true' })).toBe('/users/me%3Fadmin=true')
  })
})
