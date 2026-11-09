import type { StandardHeaders } from '@standard-server/core'

import { toFetchHeaders, toStandardHeaders } from './headers'

it('toStandardHeaders', () => {
  const headers = new Headers()

  headers.append('content-type', 'application/json')
  headers.append('x-custom-header', 'custom-value')
  headers.append('set-cookie', 'foo=bar')
  headers.append('set-cookie', 'bar=baz')
  headers.append('set-cookie', '3=3')

  const standardHeaders = toStandardHeaders(headers)

  expect(standardHeaders).toEqual({
    'content-type': 'application/json',
    'x-custom-header': 'custom-value',
    'set-cookie': ['foo=bar', 'bar=baz', '3=3'],
  })
})

it('toStandardHeaders with a __proto__ header', () => {
  const headers = new Headers()

  headers.append('__proto__', 'polluted')
  headers.append('content-type', 'application/json')

  const standardHeaders = toStandardHeaders(headers)

  expect(Object.getPrototypeOf(standardHeaders)).toBe(null)
  expect(Object.getOwnPropertyDescriptor(standardHeaders, '__proto__')?.value).toBe('polluted')
  expect(standardHeaders['content-type']).toBe('application/json')
})

it('toFetchHeaders', () => {
  const standardHeaders: StandardHeaders = {
    'content-type': 'application/json',
    'x-custom-header': ['custom-value'],
    'set-cookie': ['foo=bar', 'bar=baz'],
    'some-thing': undefined,
  }

  const fetchHeaders = toFetchHeaders(standardHeaders)

  expect([...fetchHeaders]).toEqual([
    ['content-type', 'application/json'],
    ['set-cookie', 'foo=bar'],
    ['set-cookie', 'bar=baz'],
    ['x-custom-header', 'custom-value'],
  ])
})

it('toFetchHeaders skips http2 pseudo-headers', () => {
  const standardHeaders: StandardHeaders = {
    ':method': 'POST',
    ':path': '/hello?foo=bar',
    ':scheme': 'https',
    ':authority': 'example.com',
    'content-type': 'application/json',
  }

  const fetchHeaders = toFetchHeaders(standardHeaders)

  expect([...fetchHeaders]).toEqual([['content-type', 'application/json']])
})
