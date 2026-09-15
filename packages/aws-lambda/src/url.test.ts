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

describe('toStandardUrl path escaping', () => {
  // HTTP APIs deliver the path url-decoded, values observed on a live API Gateway HTTP API
  const decoded: [rawPath: string, pathname: string][] = [
    ['/capture/space value', '/capture/space%20value'],
    ['/capture/hash#value', '/capture/hash%23value'],
    ['/capture/literal?value', '/capture/literal%3Fvalue'],
    ['/capture/literal%value', '/capture/literal%25value'],
    ['/capture/unicode-λ-世界', '/capture/unicode-%CE%BB-%E4%B8%96%E7%95%8C'],
    ['/capture/quote"brace{}angle<>tick`caret^', '/capture/quote%22brace%7B%7Dangle%3C%3Etick%60caret%5E'],
    ['/capture/tab\tnewline\ndel\x7F', '/capture/tab%09newline%0Adel%7F'],
    ['/capture/back\\slash', '/capture/back%5Cslash'],
  ]

  // REST APIs and Lambda Function URLs deliver the path still encoded, it must not be double-encoded
  const encoded = [
    '/capture/space%20value',
    '/capture/question%3Fvalue',
    '/capture/hash%23value',
    '/capture/slash%2Fvalue',
    '/capture/percent%25done',
    '/capture/literal%2525value',
    '/capture/unicode-%CE%BB-%E4%B8%96%E7%95%8C',
    '/capture/lower%2fcase',
    '/a[b]/c;d=e,f@g:h!i\'j(k)*l+m$n&o~p-q_r.s',
  ]

  describe('v2', () => {
    it.each(decoded)('escapes decoded %s', (rawPath, pathname) => {
      expect(toStandardUrl({ rawPath, requestContext: { http: { method: 'GET' } } })).toBe(pathname)
    })

    it.each(encoded)('keeps encoded %s as-is', (rawPath) => {
      expect(toStandardUrl({ rawPath, requestContext: { http: { method: 'GET' } } })).toBe(rawPath)
    })

    it('keeps the query string separate from a decoded ? or # in the path', () => {
      expect(toStandardUrl({
        rawPath: '/orders#',
        rawQueryString: 'tenant=acme',
        requestContext: { http: { method: 'GET' } },
      })).toBe('/orders%23?tenant=acme')

      expect(toStandardUrl({
        rawPath: '/users/me?admin=true',
        rawQueryString: 'tenant=acme',
        requestContext: { http: { method: 'GET' } },
      })).toBe('/users/me%3Fadmin=true?tenant=acme')
    })
  })

  describe('v1', () => {
    it.each(decoded)('escapes decoded %s', (path, pathname) => {
      expect(toStandardUrl({ httpMethod: 'GET', path })).toBe(pathname)
    })

    it.each(encoded)('keeps encoded %s as-is', (path) => {
      expect(toStandardUrl({ httpMethod: 'GET', path })).toBe(path)
    })

    it('keeps the query string separate from a decoded ? or # in the path', () => {
      expect(toStandardUrl({
        httpMethod: 'GET',
        path: '/orders#',
        queryStringParameters: { tenant: 'acme' },
      })).toBe('/orders%23?tenant=acme')

      expect(toStandardUrl({
        httpMethod: 'GET',
        path: '/users/me?admin=true',
        queryStringParameters: { tenant: 'acme' },
      })).toBe('/users/me%3Fadmin=true?tenant=acme')
    })
  })

  it('adds a leading slash after escaping', () => {
    expect(toStandardUrl({ httpMethod: 'GET', path: 'a b' })).toBe('/a%20b')
    expect(toStandardUrl({ rawPath: 'a b', requestContext: { http: { method: 'GET' } } })).toBe('/a%20b')
  })
})
