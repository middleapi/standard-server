import type { AnyAPIGatewayProxyEvent } from './types'
import { toStandardUrl } from './url'

describe('toStandardUrl (v2)', () => {
  it('works without query string', () => {
    expect(
      toStandardUrl({
        rawPath: '/example',
        requestContext: { http: { method: 'GET' } },
      }),
    ).toBe('/example')

    expect(
      toStandardUrl({
        rawPath: '/example',
        rawQueryString: '',
        requestContext: { http: { method: 'GET' } },
      }),
    ).toBe('/example')
  })

  it('adds a leading slash when missing', () => {
    expect(
      toStandardUrl({
        rawPath: 'example',
        requestContext: { http: { method: 'GET' } },
      }),
    ).toBe('/example')
  })

  it('uses rawQueryString as-is', () => {
    expect(
      toStandardUrl({
        rawPath: '/example',
        rawQueryString: 'foo=bar&foo=baz&a+key=a+value%26%3D%23',
        requestContext: { http: { method: 'GET' } },
      }),
    ).toBe('/example?foo=bar&foo=baz&a+key=a+value%26%3D%23')
  })
})

describe('toStandardUrl (v1)', () => {
  it('works without query string', () => {
    expect(toStandardUrl({ httpMethod: 'GET', path: '/example' })).toBe('/example')
  })

  it('detects v1 by the top-level httpMethod field', () => {
    // a v1 event carries a requestContext too, it must not be mistaken for v2
    expect(
      toStandardUrl({
        httpMethod: 'GET',
        path: '/example',
        requestContext: {},
        queryStringParameters: { foo: 'bar' },
      } as any),
    ).toBe('/example?foo=bar')
  })

  it('adds a leading slash when missing', () => {
    expect(toStandardUrl({ httpMethod: 'GET', path: 'example' })).toBe('/example')
  })

  it('merges both sources, preferring multiValueQueryStringParameters per key', () => {
    expect(
      toStandardUrl({
        httpMethod: 'GET',
        path: '/example',
        queryStringParameters: { foo: 'ignored', only: 'kept' },
        multiValueQueryStringParameters: { foo: ['bar', 'baz'], hello: ['world'] },
      }),
    ).toBe('/example?foo=bar&foo=baz&hello=world&only=kept')
  })

  it('skips undefined multiValueQueryStringParameters values', () => {
    expect(
      toStandardUrl({
        httpMethod: 'GET',
        path: '/example',
        multiValueQueryStringParameters: { foo: ['bar'], skipped: undefined },
      }),
    ).toBe('/example?foo=bar')
  })

  it('falls back to queryStringParameters', () => {
    expect(
      toStandardUrl({
        httpMethod: 'GET',
        path: '/example',
        queryStringParameters: { foo: 'bar', empty: '', skipped: undefined },
        multiValueQueryStringParameters: null,
      }),
    ).toBe('/example?foo=bar&empty=')
  })

  it('re-encodes decoded query string parameters', () => {
    expect(
      toStandardUrl({
        httpMethod: 'GET',
        path: '/example',
        multiValueQueryStringParameters: { 'a key': ['a value&=#'] },
      }),
    ).toBe(`/example?${new URLSearchParams({ 'a key': 'a value&=#' })}`)
  })

  it('ignores empty query containers', () => {
    expect(
      toStandardUrl({
        httpMethod: 'GET',
        path: '/example',
        queryStringParameters: null,
        multiValueQueryStringParameters: {},
      }),
    ).toBe('/example')
  })
})

describe('toStandardUrl path escaping', () => {
  // HTTP APIs deliver the path url-decoded, values observed on a live API Gateway HTTP API
  const decoded: [rawPath: string, pathname: string][] = [
    ['/capture/space value', '/capture/space%20value'],
    ['/capture/hash#value', '/capture/hash%23value'],
    ['/capture/literal?value', '/capture/literal%3Fvalue'],
    ['/capture/unicode-λ-世界', '/capture/unicode-%CE%BB-%E4%B8%96%E7%95%8C'],
    [
      '/capture/quote"brace{}angle<>tick`caret^',
      '/capture/quote%22brace%7B%7Dangle%3C%3Etick%60caret%5E',
    ],
    ['/capture/tab\tnewline\ndel\x7F', '/capture/tab%09newline%0Adel%7F'],
    // encodeURIComponent throws URIError on a lone surrogate, it becomes U+FFFD instead
    ['/capture/lone\uD800surrogate', '/capture/lone%EF%BF%BDsurrogate'],
  ]

  // REST APIs and Lambda Function URLs deliver the path still encoded, it must not be double-encoded,
  // and characters `URL` leaves alone in a pathname stay as-is too
  const untouched = [
    '/capture/space%20value',
    '/capture/question%3Fvalue',
    '/capture/hash%23value',
    '/capture/slash%2Fvalue',
    '/capture/percent%25done',
    '/capture/literal%2525value',
    '/capture/unicode-%CE%BB-%E4%B8%96%E7%95%8C',
    '/capture/lower%2fcase',
    "/AZaz09-._~!$&'()*+,;=:@",
    '/a[b]|c\\d',
    '/capture/literal%value',
  ]

  // events without an HTTP API marker (REST APIs, hand-built events) keep the path as encoded
  describe('v2', () => {
    it.each(decoded)('escapes decoded %s', (rawPath, pathname) => {
      expect(toStandardUrl({ rawPath, requestContext: { http: { method: 'GET' } } })).toBe(pathname)
    })

    it.each(untouched)('keeps %s as-is', (rawPath) => {
      expect(toStandardUrl({ rawPath, requestContext: { http: { method: 'GET' } } })).toBe(rawPath)
    })

    it('keeps the query string separate from a decoded ? or # in the path', () => {
      expect(
        toStandardUrl({
          rawPath: '/orders#',
          rawQueryString: 'tenant=acme',
          requestContext: { http: { method: 'GET' } },
        }),
      ).toBe('/orders%23?tenant=acme')

      expect(
        toStandardUrl({
          rawPath: '/users/me?admin=true',
          rawQueryString: 'tenant=acme',
          requestContext: { http: { method: 'GET' } },
        }),
      ).toBe('/users/me%3Fadmin=true?tenant=acme')
    })
  })

  describe('v1', () => {
    it.each(decoded)('escapes decoded %s', (path, pathname) => {
      expect(toStandardUrl({ httpMethod: 'GET', path })).toBe(pathname)
    })

    it.each(untouched)('keeps %s as-is', (path) => {
      expect(toStandardUrl({ httpMethod: 'GET', path })).toBe(path)
    })

    it('keeps the query string separate from a decoded ? or # in the path', () => {
      expect(
        toStandardUrl({
          httpMethod: 'GET',
          path: '/orders#',
          queryStringParameters: { tenant: 'acme' },
        }),
      ).toBe('/orders%23?tenant=acme')

      expect(
        toStandardUrl({
          httpMethod: 'GET',
          path: '/users/me?admin=true',
          queryStringParameters: { tenant: 'acme' },
        }),
      ).toBe('/users/me%3Fadmin=true?tenant=acme')
    })
  })

  it('escapes the same characters as the URL pathname setter', () => {
    // `^` is left out: it joined the path percent-encode set in 2023 and Node 20/22 still leave it as-is
    for (const path of [
      '/space value',
      '/hash#value',
      '/literal?value',
      '/unicode-λ-世界',
      '/quote"brace{}angle<>tick`',
      '/a[b]|c',
      '/literal%value',
      '/%20%2F',
      '/lone\uD800surrogate',
    ]) {
      const url = new URL('http://localhost')
      url.pathname = path

      expect(toStandardUrl({ httpMethod: 'GET', path })).toBe(url.pathname)

      // a decoded path escapes the same characters, plus `%` and `\`
      if (!path.includes('%')) {
        expect(toStandardUrl({ httpMethod: 'GET', path }, { decodedPath: true })).toBe(url.pathname)
      }
    }
  })

  it('adds a leading slash after escaping', () => {
    expect(toStandardUrl({ httpMethod: 'GET', path: 'a b' })).toBe('/a%20b')
    expect(toStandardUrl({ rawPath: 'a b', requestContext: { http: { method: 'GET' } } })).toBe(
      '/a%20b',
    )
  })

  // left as-is, a decoded `%` is decoded twice downstream and a decoded `\` resolves like a `/`
  const doubleDecoded: [path: string, pathname: string][] = [
    ['/%61dmin/users', '/%2561dmin/users'],
    ['/files/100%', '/files/100%25'],
    ['/files/a%41b', '/files/a%2541b'],
    ['/public/x\\..\\..\\admin/deleteUser', '/public/x%5C..%5C..%5Cadmin/deleteUser'],
  ]

  const httpApiV2 = (rawPath: string): AnyAPIGatewayProxyEvent => ({
    rawPath,
    requestContext: {
      domainName: 'abc.execute-api.us-east-1.amazonaws.com',
      http: { method: 'GET' },
    },
  })

  const httpApiV1 = (path: string): AnyAPIGatewayProxyEvent => ({
    version: '1.0',
    httpMethod: 'GET',
    path,
  })

  describe.each([
    ['v2', httpApiV2],
    ['v1', httpApiV1],
  ])('HTTP API (%s)', (_, toEvent) => {
    it.each([...decoded, ...doubleDecoded])('escapes decoded %s', (path, pathname) => {
      expect(toStandardUrl(toEvent(path))).toBe(pathname)
    })

    it('decodes back to the delivered path', () => {
      for (const path of [...doubleDecoded.map(([path]) => path), ...untouched]) {
        const segments = toStandardUrl(toEvent(path)).split('/').map(decodeURIComponent)

        expect(segments).toEqual(path.split('/'))
      }
    })
  })

  it('does not let a decoded \\ resolve like a /', () => {
    const url = toStandardUrl(httpApiV1('/public/x\\..\\..\\admin/deleteUser'))

    expect(new URL(url, 'http://localhost').pathname).toBe(url)
  })

  it('detects an HTTP API on a custom domain', () => {
    expect(
      toStandardUrl({
        rawPath: '/files/100%',
        requestContext: { domainName: 'api.example.com', http: { method: 'GET' } },
      }),
    ).toBe('/files/100%25')
  })

  it.each(untouched)('keeps %s as-is from a Lambda Function URL', (rawPath) => {
    expect(
      toStandardUrl({
        rawPath,
        requestContext: {
          domainName: 'xyz.lambda-url.us-east-1.on.aws',
          http: { method: 'GET' },
        },
      }),
    ).toBe(rawPath)
  })

  it('lets decodedPath override the detection', () => {
    expect(toStandardUrl({ httpMethod: 'GET', path: '/files/100%' }, { decodedPath: true })).toBe(
      '/files/100%25',
    )
    expect(
      toStandardUrl(
        { rawPath: '/a\\b%', requestContext: { http: { method: 'GET' } } },
        { decodedPath: true },
      ),
    ).toBe('/a%5Cb%25')

    expect(toStandardUrl(httpApiV1('/percent%25done'), { decodedPath: false })).toBe(
      '/percent%25done',
    )
    expect(toStandardUrl(httpApiV2('/percent%25done'), { decodedPath: false })).toBe(
      '/percent%25done',
    )
  })
})
