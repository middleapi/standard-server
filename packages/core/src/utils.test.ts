import { flattenStandardHeader, generateContentDisposition, getFilenameFromContentDisposition, mergeStandardHeaders, parseStandardUrl, resolveStandardBodyHint } from './utils'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('generateContentDisposition', () => {
  it('handle normal filename', () => {
    expect(generateContentDisposition('test.txt')).toEqual('inline; filename="test.txt"; filename*=utf-8\'\'test.txt')
  })

  it('handle empty filename', () => {
    expect(generateContentDisposition('')).toEqual('inline; filename=""; filename*=utf-8\'\'')
  })

  it('escape " special char', () => {
    expect(generateContentDisposition('!@#$%^%^&*()\'".txt')).toEqual('inline; filename="!@#$%^%^&*()\'\\".txt"; filename*=utf-8\'\'!%40%23%24%25^%25^%26%2A%28%29%27%22.txt')
  })

  it('escape \\ special char', () => {
    expect(generateContentDisposition('a\\b.txt')).toEqual('inline; filename="a\\\\b.txt"; filename*=utf-8\'\'a%5Cb.txt')
    // a trailing backslash must not escape the closing quote
    expect(generateContentDisposition('a\\')).toEqual('inline; filename="a\\\\"; filename*=utf-8\'\'a%5C')
    expect(generateContentDisposition('a\\"; injected=x')).toEqual('inline; filename="a\\\\\\"; injected=x"; filename*=utf-8\'\'a%5C%22%3B%20injected%3Dx')
  })

  it('escape non-ASCII filenames', () => {
    expect(generateContentDisposition('テンプレ\'"ート.txt')).toEqual('inline; filename="____\'\\"__.txt"; filename*=utf-8\'\'%E3%83%86%E3%83%B3%E3%83%97%E3%83%AC%27%22%E3%83%BC%E3%83%88.txt')
  })

  it('does not throw on lone surrogates', () => {
    // encodeURIComponent throws URIError here, the lone surrogate becomes U+FFFD
    expect(generateContentDisposition('a\uD800.txt')).toEqual('inline; filename="a_.txt"; filename*=utf-8\'\'a%EF%BF%BD.txt')
  })

  it('support inline and attachment types', () => {
    expect(generateContentDisposition('test.txt', 'inline')).toEqual('inline; filename="test.txt"; filename*=utf-8\'\'test.txt')
    expect(generateContentDisposition('test.txt', 'attachment')).toEqual('attachment; filename="test.txt"; filename*=utf-8\'\'test.txt')
  })
})

it('getFilenameFromContentDisposition', () => {
  expect(getFilenameFromContentDisposition('attachment; filename=""; filename*=utf-8\'\'')).toEqual('')
  expect(getFilenameFromContentDisposition('attachment; filename="test.txt"; filename*=utf-8\'\'test.txt')).toEqual('test.txt')
  expect(getFilenameFromContentDisposition('attachment; filename="!@#$%^%^&*()\'".txt"; filename*=utf-8\'\'!%40%23%24%25^%25^%26%2A%28%29%27%22.txt')).toEqual('!@#$%^%^&*()\'".txt')

  expect(getFilenameFromContentDisposition('attachment; filename=""')).toEqual('')
  expect(getFilenameFromContentDisposition('attachment; filename="test.txt"')).toEqual('test.txt')
  expect(getFilenameFromContentDisposition('attachment; filename="!@#$%^%^&*()\'\\".txt"')).toEqual('!@#$%^%^&*()\'".txt')
  expect(getFilenameFromContentDisposition('attachment; filename="a\\\\b.txt"')).toEqual('a\\b.txt')
  expect(getFilenameFromContentDisposition('attachment; filename="a\\\\"')).toEqual('a\\')

  expect(getFilenameFromContentDisposition('attachment; filename*=utf-8\'\'')).toEqual('')
  expect(getFilenameFromContentDisposition('attachment; filename*=utf-8\'\'test.txt')).toEqual('test.txt')
  expect(getFilenameFromContentDisposition('attachment; filename*=utf-8\'\'!%40%23%24%25^%25^%26%2A%28%29%27%22.txt')).toEqual('!@#$%^%^&*()\'".txt')

  expect(getFilenameFromContentDisposition('inline; filename="hello.txt"')).toEqual('hello.txt')
  expect(getFilenameFromContentDisposition('inline; filename="hello.txt"; size=123')).toEqual('hello.txt')
  expect(getFilenameFromContentDisposition('inline; filename"hello.txt"; size=123')).toEqual(undefined)

  expect(getFilenameFromContentDisposition('inline; filename*=!%40%23%24%25^%25^%26%2A%28%29%27%22.txt; size=123')).toEqual('!@#$%^%^&*()\'".txt')

  // unquoted token form
  expect(getFilenameFromContentDisposition('attachment; filename=report.pdf')).toEqual('report.pdf')
  expect(getFilenameFromContentDisposition('attachment; filename=report.pdf; size=123')).toEqual('report.pdf')
  expect(getFilenameFromContentDisposition('attachment; filename=')).toEqual(undefined)

  // param names must be anchored, not substring-matched
  expect(getFilenameFromContentDisposition('attachment; xfilename*=evil')).toEqual(undefined)
  expect(getFilenameFromContentDisposition('attachment; filename="good.txt"; xfilename*=evil.exe')).toEqual('good.txt')
  expect(getFilenameFromContentDisposition('attachment; creation-filename="e.exe"')).toEqual(undefined)
  expect(getFilenameFromContentDisposition('filename*=utf-8\'\'first.txt')).toEqual('first.txt')
  expect(getFilenameFromContentDisposition('filename=first.txt')).toEqual('first.txt')

  // ext-value charset and language prefix
  expect(getFilenameFromContentDisposition('attachment; filename*=utf-8\'en\'%E2%82%AC.txt')).toEqual('€.txt')
  expect(getFilenameFromContentDisposition('attachment; filename*=UTF-8\'\'%E2%82%AC.txt')).toEqual('€.txt')
  expect(getFilenameFromContentDisposition('attachment; filename*=us-ascii\'en\'test.txt')).toEqual('test.txt')
  expect(getFilenameFromContentDisposition('attachment; filename*=iso-8859-1\'\'%E9.txt; filename="fallback.txt"')).toEqual('fallback.txt')
  expect(getFilenameFromContentDisposition('attachment; filename*=iso-8859-1\'\'%E9.txt')).toEqual(undefined)
})

describe('resolveStandardBodyHint', () => {
  it('standard-server header wins over content headers', () => {
    expect(resolveStandardBodyHint({ 'standard-server': 'none', 'content-length': '3', 'content-type': 'application/pdf' })).toBe('none')
    expect(resolveStandardBodyHint({ 'standard-server': 'json', 'content-length': '3', 'content-type': 'application/pdf' })).toBe('json')
    expect(resolveStandardBodyHint({ 'standard-server': ['file'], 'content-type': 'application/json' })).toBe('file')
    expect(resolveStandardBodyHint({ 'standard-server': 'octet-stream', 'content-length': '3' })).toBe('octet-stream')
    expect(resolveStandardBodyHint({ 'standard-server': 'event-stream', 'content-length': '3', 'content-type': 'application/json' })).toBe('event-stream')
    expect(resolveStandardBodyHint({ 'standard-server': 'form-data', 'content-length': '3', 'content-type': 'application/json' })).toBe('form-data')
    expect(resolveStandardBodyHint({ 'standard-server': 'url-search-params', 'content-length': '3', 'content-type': 'application/json' })).toBe('url-search-params')
  })

  it('ignores an unrecognized standard-server header', () => {
    expect(resolveStandardBodyHint({ 'standard-server': 'invalid', 'content-type': 'application/json' })).toBe('json')
    expect(resolveStandardBodyHint({ 'standard-server': '', 'content-length': '3' })).toBe('file')
    // a repeated header flattens to a comma-joined value, which is not a hint
    expect(resolveStandardBodyHint({ 'standard-server': ['file', 'json'] })).toBe('none')
  })

  it('falls back to content headers when the standard-server header is unset', () => {
    expect(resolveStandardBodyHint({ 'standard-server': undefined, 'content-length': '3' })).toBe('file')
    // an empty array is the unset-header convention
    expect(resolveStandardBodyHint({ 'standard-server': [], 'content-length': '3' })).toBe('file')
  })

  it('none when no content-type and no meaningful content-length', () => {
    expect(resolveStandardBodyHint({})).toBe('none')
    expect(resolveStandardBodyHint({ 'content-length': '0' })).toBe('none')
    expect(resolveStandardBodyHint({ 'content-type': [], 'content-length': [] })).toBe('none')
  })

  it('by content-type', () => {
    expect(resolveStandardBodyHint({ 'content-type': 'application/json' })).toBe('json')
    expect(resolveStandardBodyHint({ 'content-type': 'application/json; charset=utf-8' })).toBe('json')
    expect(resolveStandardBodyHint({ 'content-type': ' application/json ' })).toBe('json')
    expect(resolveStandardBodyHint({ 'content-type': 'multipart/form-data; boundary=x' })).toBe('form-data')
    expect(resolveStandardBodyHint({ 'content-type': 'application/x-www-form-urlencoded' })).toBe('url-search-params')
    expect(resolveStandardBodyHint({ 'content-type': 'text/event-stream' })).toBe('event-stream')

    // content-type wins over content-length
    expect(resolveStandardBodyHint({ 'content-type': 'application/json', 'content-length': '3' })).toBe('json')
  })

  it('matches the content-type case-insensitively, as media types are', () => {
    expect(resolveStandardBodyHint({ 'content-type': 'Application/JSON' })).toBe('json')
    expect(resolveStandardBodyHint({ 'content-type': 'APPLICATION/JSON; CHARSET=UTF-8' })).toBe('json')
    expect(resolveStandardBodyHint({ 'content-type': 'Multipart/Form-Data; boundary=x' })).toBe('form-data')
    expect(resolveStandardBodyHint({ 'content-type': 'APPLICATION/X-WWW-FORM-URLENCODED' })).toBe('url-search-params')
    expect(resolveStandardBodyHint({ 'content-type': 'Text/Event-Stream' })).toBe('event-stream')

    // the standard-server header is ours, so it stays exact and an uppercase value is not a hint
    expect(resolveStandardBodyHint({ 'standard-server': 'JSON', 'content-type': 'application/pdf', 'content-length': '3' })).toBe('file')
    expect(resolveStandardBodyHint({ 'standard-server': 'None' })).toBe('none')
  })

  it('file when content-length is present', () => {
    expect(resolveStandardBodyHint({ 'content-length': '3' })).toBe('file')
    expect(resolveStandardBodyHint({ 'content-length': ['3'] })).toBe('file')
    expect(resolveStandardBodyHint({ 'content-length': '3', 'content-type': 'application/pdf' })).toBe('file')
    // an empty file is still a file when a content-type is present
    expect(resolveStandardBodyHint({ 'content-length': '0', 'content-type': 'application/pdf' })).toBe('file')
    // an empty content-type is a valid content-type, not an absent one
    expect(resolveStandardBodyHint({ 'content-length': '0', 'content-type': '' })).toBe('file')
    expect(resolveStandardBodyHint({ 'content-length': '0', 'content-type': ' ; charset=utf-8' })).toBe('file')
  })

  it('file when content-disposition carries a filename', () => {
    // a compressing proxy rewrites content-length, content-disposition reaches the receiver untouched
    expect(resolveStandardBodyHint({ 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="a.pdf"' })).toBe('file')
    expect(resolveStandardBodyHint({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename*=utf-8\'\'a.pdf' })).toBe('file')
    // an empty filename is still a filename
    expect(resolveStandardBodyHint({ 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename=""' })).toBe('file')

    // nothing to extract, so it says nothing about the body
    expect(resolveStandardBodyHint({ 'content-type': 'application/pdf', 'content-disposition': 'attachment' })).toBe('octet-stream')
    expect(resolveStandardBodyHint({ 'content-type': 'application/pdf', 'content-disposition': [] })).toBe('octet-stream')

    // a filename does not rescue a body the other content headers already report as empty
    expect(resolveStandardBodyHint({ 'content-disposition': 'inline; filename="a.pdf"' })).toBe('none')
    expect(resolveStandardBodyHint({ 'content-disposition': 'inline; filename="a.pdf"', 'content-length': '0' })).toBe('none')

    // a common content-type still wins
    expect(resolveStandardBodyHint({ 'content-type': 'application/json', 'content-disposition': 'inline; filename="a.json"' })).toBe('json')
    // and an explicit hint still wins over everything
    expect(resolveStandardBodyHint({ 'standard-server': 'none', 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="a.pdf"' })).toBe('none')
  })

  it('octet-stream when content-length is absent', () => {
    expect(resolveStandardBodyHint({ 'content-type': 'application/octet-stream' })).toBe('octet-stream')
    expect(resolveStandardBodyHint({ 'content-type': 'application/pdf' })).toBe('octet-stream')
    expect(resolveStandardBodyHint({ 'content-type': 'text/plain', 'content-length': [] })).toBe('octet-stream')
    expect(resolveStandardBodyHint({ 'content-type': '' })).toBe('octet-stream')
  })
})

describe('mergeStandardHeaders', () => {
  afterEach(() => {
    expect(({} as any).polluted).toEqual(undefined)
    expect(({} as any).a).toEqual(undefined)
  })

  it('merge duplicated keys', () => {
    expect(mergeStandardHeaders({ a: '1' }, { a: '2' })).toEqual({ a: ['1', '2'] })
    expect(mergeStandardHeaders({ a: ['1'] }, { a: '2' })).toEqual({ a: ['1', '2'] })
    expect(mergeStandardHeaders({ a: ['1', '2'] }, { a: '3' })).toEqual({ a: ['1', '2', '3'] })
    expect(mergeStandardHeaders({ a: ['1', '2'] }, { a: ['3'] })).toEqual({ a: ['1', '2', '3'] })
    expect(mergeStandardHeaders({ a: ['1', '2'] }, { a: ['3', '4'] })).toEqual({ a: ['1', '2', '3', '4'] })
  })

  it('handle distinct and undefined keys', () => {
    expect(mergeStandardHeaders({ a: '1' }, { b: '2' })).toEqual({ a: '1', b: '2' })
    expect(mergeStandardHeaders({ a: '1', b: undefined }, { b: '2' })).toEqual({ a: '1', b: '2' })
    expect(mergeStandardHeaders({ a: '1' }, { a: undefined, b: '2' })).toEqual({ a: '1', b: '2' })

    // an unset marker coming only from b is carried through, like `headers['content-type'] = undefined`
    expect(Object.keys(mergeStandardHeaders({ a: '1' }, { b: undefined }))).toEqual(['a', 'b'])
  })

  it('keep keys of a in position, then keys only in b', () => {
    expect(Object.keys(mergeStandardHeaders({ c: '1', a: '2' }, { b: '3', a: '4' }))).toEqual(['c', 'a', 'b'])
  })

  it('not pollute the prototype through __proto__ in b', () => {
    const b = JSON.parse('{ "__proto__": { "polluted": "yes" } }')

    const merged = mergeStandardHeaders({ a: '1' }, b)

    expect(Object.getPrototypeOf(merged)).toEqual(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value).toEqual({ polluted: 'yes' })
    expect(merged.a).toEqual('1')
  })

  it('not pollute the prototype through __proto__ in both a and b', () => {
    const a = JSON.parse('{ "__proto__": "1" }')
    const b = JSON.parse('{ "__proto__": "2" }')

    const merged = mergeStandardHeaders(a, b)

    expect(Object.getPrototypeOf(merged)).toEqual(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value).toEqual(['1', '2'])
  })
})

it('flattenStandardHeader', () => {
  expect(flattenStandardHeader(['a', 'b'])).toEqual('a, b')
  expect(flattenStandardHeader([])).toEqual(undefined)
  expect(flattenStandardHeader('a')).toEqual('a')
  expect(flattenStandardHeader(undefined)).toEqual(undefined)
})

describe('parseStandardUrl', () => {
  it('should parse pathname only', () => {
    expect(parseStandardUrl('/')).toEqual([
      '/',
      undefined,
      undefined,
    ])

    expect(parseStandardUrl('/users/123/profile')).toEqual([
      '/users/123/profile',
      undefined,
      undefined,
    ])
  })

  it('should parse pathname with search params', () => {
    expect(parseStandardUrl('/search?q=test&page=2')).toEqual([
      '/search',
      '?q=test&page=2',
      undefined,
    ])
  })

  it('should parse pathname with hash', () => {
    expect(parseStandardUrl('/docs#intro')).toEqual([
      '/docs',
      undefined,
      '#intro',
    ])
  })

  it('should parse pathname with search and hash', () => {
    expect(parseStandardUrl('/products?category=electronics#reviews')).toEqual([
      '/products',
      '?category=electronics',
      '#reviews',
    ])
  })

  it('should handle hash before search (hash takes priority)', () => {
    expect(parseStandardUrl('/page#section?query=1')).toEqual([
      '/page',
      undefined,
      '#section?query=1',
    ])
  })

  it('should handle multiple question marks and hashes', () => {
    expect(parseStandardUrl('/page?q=1?extra=2')).toEqual([
      '/page',
      '?q=1?extra=2',
      undefined,
    ])

    expect(parseStandardUrl('/page#hash#another')).toEqual([
      '/page',
      undefined,
      '#hash#another',
    ])

    expect(parseStandardUrl('/page?q=1?x=2#sec#sub')).toEqual([
      '/page',
      '?q=1?x=2',
      '#sec#sub',
    ])

    expect(parseStandardUrl('/page#sec?q=1#sub?x=2')).toEqual([
      '/page',
      undefined,
      '#sec?q=1#sub?x=2',
    ])
  })

  it('should handle empty search and hash markers', () => {
    expect(parseStandardUrl('/page?#')).toEqual([
      '/page',
      '?',
      '#',
    ])
  })
})
