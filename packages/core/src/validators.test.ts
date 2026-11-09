import {
  isStandardHeaders,
  isStandardMethod,
  isStandardRequest,
  isStandardResponse,
  isStandardStatus,
  isStandardUrl,
} from './validators'

describe('isStandardMethod', () => {
  it('accepts standard & custom HTTP verbs', () => {
    for (const method of [
      'GET',
      'POST',
      'PUT',
      'DELETE',
      'PATCH',
      'OPTIONS',
      'HEAD',
      'QUERY',
      'CUSTOM',
      'anything',
    ]) {
      expect(isStandardMethod(method)).toBe(true)
    }
  })

  it('rejects non-string values', () => {
    expect(isStandardMethod(null)).toBe(false)
    expect(isStandardMethod(42)).toBe(false)
    expect(isStandardMethod({})).toBe(false)
    expect(isStandardMethod(undefined)).toBe(false)
  })
})

describe('isStandardUrl', () => {
  it('accepts paths starting with /', () => {
    expect(isStandardUrl('/')).toBe(true)
    expect(isStandardUrl('/example')).toBe(true)
    expect(isStandardUrl('/example?query=1')).toBe(true)
    expect(isStandardUrl('/example#fragment')).toBe(true)
    expect(isStandardUrl('/example?q=1#frag')).toBe(true)
  })

  it('rejects paths not starting with /', () => {
    expect(isStandardUrl('example')).toBe(false)
    expect(isStandardUrl('http://example.com')).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isStandardUrl(null)).toBe(false)
    expect(isStandardUrl(42)).toBe(false)
    expect(isStandardUrl({})).toBe(false)
  })
})

describe('isStandardHeaders', () => {
  it('accepts an empty headers object', () => {
    expect(isStandardHeaders({})).toBe(true)
  })

  it('accepts string values', () => {
    expect(isStandardHeaders({ 'content-type': 'application/json' })).toBe(true)
  })

  it('accepts string array values', () => {
    expect(isStandardHeaders({ 'set-cookie': ['a=1', 'b=2'] })).toBe(true)
  })

  it('accepts undefined values', () => {
    expect(isStandardHeaders({ accept: undefined })).toBe(true)
  })

  it('rejects values that are not string, string[], or undefined', () => {
    expect(isStandardHeaders({ 'x-count': 42 })).toBe(false)
    expect(isStandardHeaders({ flag: true })).toBe(false)
    expect(isStandardHeaders({ nested: { a: '1' } })).toBe(false)
    expect(isStandardHeaders({ bad: [1, 2] })).toBe(false)
  })

  it('rejects non-object values', () => {
    expect(isStandardHeaders(null)).toBe(false)
    expect(isStandardHeaders('string')).toBe(false)
    expect(isStandardHeaders(1)).toBe(false)
  })
})

describe('isStandardStatus', () => {
  it('accepts valid status codes', () => {
    expect(isStandardStatus(-3000)).toBe(true)
    expect(isStandardStatus(200)).toBe(true)
    expect(isStandardStatus(404)).toBe(true)
    expect(isStandardStatus(500)).toBe(true)
  })

  it('rejects invalid status codes', () => {
    expect(isStandardStatus(10.1)).toBe(false)
    expect(isStandardStatus(Number.NaN)).toBe(false)
    expect(isStandardStatus('200')).toBe(false)
    expect(isStandardStatus(null)).toBe(false)
    expect(isStandardStatus(undefined)).toBe(false)
  })
})

describe('isStandardRequest', () => {
  const valid = {
    method: 'GET',
    url: '/api/resource',
    headers: { accept: 'application/json' },
  }

  it('accepts a valid minimal request', () => {
    expect(isStandardRequest(valid)).toBe(true)
  })

  it('accepts request with body and signal', () => {
    expect(
      isStandardRequest({
        ...valid,
        body: undefined,
        signal: new AbortController().signal,
      }),
    ).toBe(true)
  })

  it('rejects when method is invalid', () => {
    expect(isStandardRequest({ ...valid, method: undefined })).toBe(false)
  })

  it('rejects when url is invalid', () => {
    expect(isStandardRequest({ ...valid, url: 123 })).toBe(false)
  })

  it('rejects when headers are invalid', () => {
    expect(isStandardRequest({ ...valid, headers: { bad: 42 } })).toBe(false)
  })

  it('rejects when signal is not an AbortSignal', () => {
    expect(isStandardRequest({ ...valid, signal: {} })).toBe(false)
    expect(isStandardRequest({ ...valid, signal: 'abort' })).toBe(false)
  })

  it('rejects non-object values', () => {
    expect(isStandardRequest(null)).toBe(false)
    expect(isStandardRequest('string')).toBe(false)
  })
})

describe('isStandardResponse', () => {
  const valid = {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }

  it('accepts valid responses across status ranges', () => {
    for (const status of [100, 200, 301, 404, 500, 599]) {
      expect(isStandardResponse({ ...valid, status })).toBe(true)
    }
  })

  it('rejects invalid status', () => {
    expect(isStandardResponse({ ...valid, status: 200.5 })).toBe(false)
    expect(isStandardResponse({ ...valid, status: '200' })).toBe(false)
    expect(isStandardResponse({ ...valid, status: Number.NaN })).toBe(false)
  })

  it('rejects invalid headers', () => {
    expect(isStandardResponse({ ...valid, headers: null })).toBe(false)
  })

  it('rejects non-object values', () => {
    expect(isStandardResponse(null)).toBe(false)
    expect(isStandardResponse(123)).toBe(false)
  })
})
