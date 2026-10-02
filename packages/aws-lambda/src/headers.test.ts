import { toLambdaHeaders, toStandardHeaders } from './headers'

describe('toStandardHeaders (v2)', () => {
  it('lowercases keys and restores the cookie header', () => {
    expect(
      toStandardHeaders({
        rawPath: '/',
        requestContext: { http: { method: 'GET' } },
        headers: {
          'Content-Type': 'application/json',
          'X-Custom': 'one, two',
          'X-Skipped': undefined,
        },
        cookies: ['foo=bar', 'bar=baz'],
      }),
    ).toEqual({
      'content-type': 'application/json',
      'x-custom': 'one, two',
      'cookie': 'foo=bar; bar=baz',
    })
  })

  it('prefers a cookie header over the cookies field', () => {
    expect(
      toStandardHeaders({
        rawPath: '/',
        requestContext: { http: { method: 'GET' } },
        headers: { Cookie: 'a=b' },
        cookies: ['foo=bar'],
      }),
    ).toEqual({
      cookie: 'a=b',
    })
  })

  it('ignores empty or missing cookies', () => {
    expect(
      toStandardHeaders({
        rawPath: '/',
        requestContext: { http: { method: 'GET' } },
        headers: { 'x-custom': 'value' },
        cookies: [],
      }),
    ).toEqual({
      'x-custom': 'value',
    })

    expect(
      toStandardHeaders({
        rawPath: '/',
        requestContext: { http: { method: 'GET' } },
      }),
    ).toEqual({})
  })
})

describe('toStandardHeaders (v1)', () => {
  it('merges both sources, preferring multiValueHeaders per key, and lowercases keys', () => {
    expect(
      toStandardHeaders({
        httpMethod: 'GET',
        path: '/',
        headers: {
          'Content-Type': 'ignored in favor of multiValueHeaders',
          'X-Only-In-Headers': 'kept',
          'X-Skipped-Single': undefined,
        },
        multiValueHeaders: {
          'Content-Type': ['application/json'],
          'X-Custom': ['one', 'two'],
          'X-Empty': [],
          'X-Skipped': undefined,
        },
      }),
    ).toEqual({
      'content-type': 'application/json',
      'x-custom': ['one', 'two'],
      'x-only-in-headers': 'kept',
    })
  })

  it('merges multiValueHeaders keys differing only in case', () => {
    expect(
      toStandardHeaders({
        httpMethod: 'GET',
        path: '/',
        multiValueHeaders: {
          'x-custom': ['one'],
          'X-Custom': ['two', 'three'],
        },
      }),
    ).toEqual({
      'x-custom': ['one', 'two', 'three'],
    })
  })

  it('falls back to headers', () => {
    expect(
      toStandardHeaders({
        httpMethod: 'GET',
        path: '/',
        multiValueHeaders: null,
        headers: {
          'Content-Type': 'application/json',
          'x-custom': 'value',
          'x-skipped': undefined,
        },
      }),
    ).toEqual({
      'content-type': 'application/json',
      'x-custom': 'value',
    })
  })

  it('returns an empty object when no headers are present', () => {
    expect(toStandardHeaders({ httpMethod: 'GET', path: '/' })).toEqual({})
  })

  it('keeps __proto__ header as a plain own property', () => {
    const headers = toStandardHeaders({
      httpMethod: 'GET',
      path: '/',
      multiValueHeaders: JSON.parse('{"__proto__": ["injected"]}'),
    })

    expect(Object.getOwnPropertyDescriptor(headers, '__proto__')?.value).toBe('injected')
    expect(Object.getPrototypeOf(headers)).toBe(null)
  })
})

describe('toLambdaHeaders', () => {
  it('joins multi-value headers and separates set-cookie', () => {
    expect(
      toLambdaHeaders({
        'content-type': 'application/json',
        'x-custom': ['one', 'two'],
        'x-skipped': undefined,
        'x-empty': [],
        'x-empty-string': '',
        'set-cookie': ['foo=bar', 'bar=baz'],
      }),
    ).toEqual([
      {
        'content-type': 'application/json',
        'x-custom': 'one, two',
        'x-empty-string': '',
      },
      ['foo=bar', 'bar=baz'],
    ])
  })

  it('supports a single set-cookie string case-insensitively', () => {
    expect(
      toLambdaHeaders({
        'Set-Cookie': 'foo=bar',
      }),
    ).toEqual([{}, ['foo=bar']])
  })
})
