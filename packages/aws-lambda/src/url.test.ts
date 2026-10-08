import { safeDecodeURIComponent } from '@standard-server/shared'

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
  const v2 = (domainName?: string) => (rawPath: string) => ({
    rawPath,
    requestContext: { domainName, http: { method: 'GET' } },
  })

  const httpApiV2 = v2('id.execute-api.us-east-1.amazonaws.com')
  const functionUrl = v2('url-id.lambda-url.us-east-1.on.aws')
  const httpApiV1 = (path: string) => ({ version: '1.0', httpMethod: 'GET', path })
  const restApi = (path: string) => ({ httpMethod: 'GET', path })

  // HTTP APIs deliver the path url-decoded, values observed on a live API Gateway HTTP API
  const decoded: [path: string, pathname: string][] = [
    ['/capture/space value', '/capture/space%20value'],
    ['/capture/hash#value', '/capture/hash%23value'],
    ['/capture/literal?value', '/capture/literal%3Fvalue'],
    ['/capture/unicode-λ-世界', '/capture/unicode-%CE%BB-%E4%B8%96%E7%95%8C'],
    [
      '/capture/quote"brace{}angle<>tick`caret^',
      '/capture/quote%22brace%7B%7Dangle%3C%3Etick%60caret%5E',
    ],
    ['/capture/bracket[value]|pipe', '/capture/bracket%5Bvalue%5D%7Cpipe'],
    ['/capture/tab\tnewline\ndel\x7F', '/capture/tab%09newline%0Adel%7F'],
    // a decoded `%` or `\` is data, `URL` must neither decode it again nor treat `\` as `/`
    ['/capture/literal%value', '/capture/literal%25value'],
    ['/capture/percent%25done', '/capture/percent%2525done'],
    ['/capture/literal%2525value', '/capture/literal%252525value'],
    // matched a `/public/{proxy+}` route, it must not resolve to `/secret`
    ['/public/%2e%2e/secret', '/public/%252e%252e/secret'],
    ['/public/x\\..\\..\\secret', '/public/x%5C..%5C..%5Csecret'],
    // encodeURIComponent throws URIError on a lone surrogate, it becomes U+FFFD instead
    ['/capture/lone\uD800surrogate', '/capture/lone%EF%BF%BDsurrogate'],
  ]

  // REST APIs, ALB and Lambda Function URLs deliver the path still encoded, it must not be double-encoded,
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
    '/public/%2e%2e/secret',
    "/AZaz09-._~!$&'()*+,;=:@",
    '/a[b]|c\\d',
    '/capture/literal%value',
  ]

  describe.each([
    ['HTTP API (v2)', httpApiV2],
    ['HTTP API (v1)', httpApiV1],
  ] as const)('%s', (_, toEvent) => {
    it.each(decoded)('escapes decoded %s', (path, pathname) => {
      expect(toStandardUrl(toEvent(path))).toBe(pathname)
    })

    it('decodes back to the delivered path exactly once', () => {
      for (const [path] of decoded.filter(([path]) => !path.includes('\uD800'))) {
        const url = new URL(toStandardUrl(toEvent(path)), 'http://localhost')

        expect(safeDecodeURIComponent(url.pathname)).toBe(path)
      }
    })
  })

  describe.each([
    ['Lambda Function URL', functionUrl],
    ['REST API', restApi],
  ] as const)('%s', (_, toEvent) => {
    it.each(untouched)('keeps %s as-is', (path) => {
      expect(toStandardUrl(toEvent(path))).toBe(path)
    })

    it('escapes like the URL pathname setter', () => {
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

        expect(toStandardUrl(toEvent(path))).toBe(url.pathname)
      }
    })
  })

  it('treats a v2 event as an HTTP API unless its domainName is a Function URL', () => {
    expect(toStandardUrl(v2()('/a%2e%2e'))).toBe('/a%252e%252e')
    expect(toStandardUrl(v2('url-id.lambda-url.example.com')('/a%2e%2e'))).toBe('/a%252e%252e')
  })

  it('keeps the query string separate from a decoded ? or # in the path', () => {
    expect(toStandardUrl({ ...httpApiV2('/orders#'), rawQueryString: 'tenant=acme' })).toBe(
      '/orders%23?tenant=acme',
    )
    expect(
      toStandardUrl({ ...httpApiV2('/users/me?admin=true'), rawQueryString: 'tenant=acme' }),
    ).toBe('/users/me%3Fadmin=true?tenant=acme')

    expect(
      toStandardUrl({ ...httpApiV1('/orders#'), queryStringParameters: { tenant: 'acme' } }),
    ).toBe('/orders%23?tenant=acme')
    expect(
      toStandardUrl({
        ...httpApiV1('/users/me?admin=true'),
        queryStringParameters: { tenant: 'acme' },
      }),
    ).toBe('/users/me%3Fadmin=true?tenant=acme')
  })

  it('adds a leading slash after escaping', () => {
    expect(toStandardUrl(restApi('a b'))).toBe('/a%20b')
    expect(toStandardUrl(httpApiV1('a%b'))).toBe('/a%25b')
    expect(toStandardUrl(httpApiV2('a%b'))).toBe('/a%25b')
    expect(toStandardUrl(functionUrl('a b'))).toBe('/a%20b')
  })
})
