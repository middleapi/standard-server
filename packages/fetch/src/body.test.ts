import * as StandardServerModule from '@standard-server/core'
import { isAsyncIteratorObject } from '@standard-server/shared'

import { toFetchBody, toStandardBody } from './body'
import * as EventStreamModule from './event-stream'
import { toFetchHeaders } from './headers'

const generateContentDispositionSpy = vi.spyOn(StandardServerModule, 'generateContentDisposition')
const getFilenameFromContentDispositionSpy = vi.spyOn(
  StandardServerModule,
  'getFilenameFromContentDisposition',
)
const toEventStreamSpy = vi.spyOn(EventStreamModule, 'toEventStream')

beforeEach(() => {
  vi.resetAllMocks()
})

describe('toStandardBody', () => {
  it('json but empty body', async () => {
    const request = new Request('https://example.com', {
      method: 'POST',
      body: '',
      headers: {
        'content-type': 'application/json',
      },
    })

    expect(await toStandardBody(request)).toEqual(undefined)
  })

  it('file', async () => {
    const file = new Blob(['{"value":123}'], { type: 'plain/text' })
    const request = new Request('https://example.com', {
      method: 'POST',
      body: file,
      headers: {
        'content-disposition': 'attachment; filename="foo.pdf"',
        'Content-Length': file.size.toString(),
      },
    })

    getFilenameFromContentDispositionSpy.mockReturnValueOnce('__name__')

    const standardFile = (await toStandardBody(request)) as any
    expect(standardFile).toBeInstanceOf(File)
    expect(standardFile.name).toBe('__name__')
    expect(standardFile.type).toBe('plain/text')
    expect(await standardFile.text()).toBe('{"value":123}')

    expect(getFilenameFromContentDispositionSpy).toHaveBeenCalledTimes(1)
    expect(getFilenameFromContentDispositionSpy).toHaveBeenCalledWith(
      'attachment; filename="foo.pdf"',
    )
  })

  describe('body hint', () => {
    it('undefined', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: 'body',
        headers: {
          'standard-server': 'none',
        },
      })

      expect(await toStandardBody(request)).toBe(undefined)
    })

    it('json', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: '{"foo":"bar"}',
        headers: {
          'standard-server': 'json',
        },
      })

      expect(await toStandardBody(request)).toEqual({ foo: 'bar' })
    })

    it('json strips a leading BOM', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: '\uFEFF{"foo":"bar"}',
        headers: {
          'standard-server': 'json',
        },
      })

      expect(await toStandardBody(request)).toEqual({ foo: 'bar' })
    })

    it('async iterator object', async () => {
      const stream = new ReadableStream<string>({
        async pull(controller) {
          controller.enqueue('event: message\ndata: 123\n\n')
          controller.enqueue('event: close\ndata: 456\n\n')
          controller.close()
        },
      }).pipeThrough(new TextEncoderStream())

      const request = new Request('https://example.com', {
        method: 'POST',
        body: stream,
        headers: {
          'standard-server': 'event-stream',
        },
        duplex: 'half',
      })

      const standardBody = (await toStandardBody(request)) as any
      expect(standardBody).toSatisfy(isAsyncIteratorObject)

      expect(await standardBody.next()).toEqual({ done: false, value: 123 })
      expect(await standardBody.next()).toEqual({ done: true, value: 456 })
    })

    it('form-data', async () => {
      const form = new FormData()
      form.append('foo', 'bar')
      form.append('bar', 'baz')

      const request = new Request('https://example.com', {
        method: 'POST',
        body: form,
        headers: {
          'standard-server': 'form-data',
        },
      })

      const result: any = await toStandardBody(request)

      expect(result).toBeInstanceOf(FormData)
      expect(result.get('foo')).toBe('bar')
      expect(result.get('bar')).toBe('baz')
    })

    it('url-search-params', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: 'foo=bar&bar=baz',
        headers: {
          'standard-server': 'url-search-params',
        },
      })

      expect(await toStandardBody(request)).toEqual(new URLSearchParams('foo=bar&bar=baz'))
    })

    it('url-search-params strips a leading BOM', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: '\uFEFFfoo=bar',
        headers: {
          'standard-server': 'url-search-params',
        },
      })

      expect(await toStandardBody(request)).toEqual(new URLSearchParams('foo=bar'))
    })

    it('file/blob', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: 'foo',
        headers: {
          'standard-server': 'file',
        },
      })

      const result: any = await toStandardBody(request)

      expect(result).toBeInstanceOf(File)
      expect(await result.text()).toBe('foo')
    })

    it('octet-stream', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: 'hello',
        headers: {
          'standard-server': 'octet-stream',
        },
      })

      const standardBody = await toStandardBody(request)
      expect(standardBody).toBeInstanceOf(ReadableStream)
      const reader = (standardBody as ReadableStream)
        .pipeThrough(new TextDecoderStream())
        .getReader()
      expect(await reader.read()).toEqual({ done: false, value: 'hello' })
      expect(await reader.read()).toEqual({ done: true, value: undefined })
    })

    it('stream (empty body)', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: null,
        headers: {
          'standard-server': 'octet-stream',
        },
      })

      const standardBody = await toStandardBody(request)
      expect(standardBody).toBeInstanceOf(ReadableStream)
      const reader = (standardBody as ReadableStream)
        .pipeThrough(new TextDecoderStream())
        .getReader()
      expect(await reader.read()).toEqual({ done: true, value: undefined })
    })
  })

  describe('edge case', () => {
    it('returns undefined when body is null despite content-type', async () => {
      const response = new Response(null, {
        headers: {
          'content-type': 'application/json',
        },
      })

      expect(await toStandardBody(response)).toBe(undefined)
    })

    it('throw on read body multiple time except (hint=none)', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: JSON.stringify({ foo: 'bar' }),
        headers: {
          'content-type': 'application/json',
        },
      })

      expect(await toStandardBody(request)).toEqual({ foo: 'bar' })
      await expect(toStandardBody(request)).rejects.toThrow(
        'Failed to read body: body stream already read',
      )
      expect(await toStandardBody(request, { hint: 'none' })).toBe(undefined)
    })

    it('fallback to user defined body hint', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: 'hello',
        headers: {
          'content-length': '567',
        },
      })

      const standardBody = await toStandardBody(request, { hint: 'octet-stream' })
      expect(standardBody).toBeInstanceOf(ReadableStream)
      const reader = (standardBody as ReadableStream)
        .pipeThrough(new TextDecoderStream())
        .getReader()
      expect(await reader.read()).toEqual({ done: false, value: 'hello' })
      expect(await reader.read()).toEqual({ done: true, value: undefined })
    })

    it('defaults to stream if no hint matches', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: 'raw data',
        headers: {
          'content-type': 'application/octet-stream',
        },
      })

      const standardBody = await toStandardBody(request)
      expect(standardBody).toBeInstanceOf(ReadableStream)
      const reader = (standardBody as ReadableStream)
        .pipeThrough(new TextDecoderStream())
        .getReader()
      expect(await reader.read()).toEqual({ done: false, value: 'raw data' })
    })

    it('parse as stream if invalid body hint', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: 'raw data',
        headers: {
          'standard-server': 'invalid',
        },
      })

      const standardBody = await toStandardBody(request)
      expect(standardBody).toBeInstanceOf(ReadableStream)
      const reader = (standardBody as ReadableStream)
        .pipeThrough(new TextDecoderStream())
        .getReader()
      expect(await reader.read()).toEqual({ done: false, value: 'raw data' })
    })

    it('prefers user defined body hint over standard-server header', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: 'raw data',
        headers: {
          'standard-server': 'json',
        },
      })

      const standardBody = await toStandardBody(request, { hint: 'octet-stream' })
      expect(standardBody).toBeInstanceOf(ReadableStream)
      const reader = (standardBody as ReadableStream)
        .pipeThrough(new TextDecoderStream())
        .getReader()
      expect(await reader.read()).toEqual({ done: false, value: 'raw data' })
    })
  })
})

describe('toFetchBody', () => {
  const baseHeaders = {
    'x-custom-header': 'custom-value',
  }

  it('undefined', () => {
    const [body, headers] = toFetchBody(undefined, baseHeaders, {})

    expect(body).toBe(undefined)
    expect(headers).toEqual({
      'x-custom-header': 'custom-value',
    })
  })

  it('json', () => {
    const [body, headers] = toFetchBody({ foo: 'bar' }, baseHeaders, {})

    expect(body).toBe('{"foo":"bar"}')
    expect(headers).toEqual({
      'content-type': 'application/json',
      'x-custom-header': 'custom-value',
    })
  })

  it('form-data', () => {
    const form = new FormData()
    form.append('foo', 'bar')
    form.append('bar', 'baz')

    const [body, headers] = toFetchBody(form, baseHeaders, {})

    expect(body).toBe(form)
    expect(headers).toEqual({
      'x-custom-header': 'custom-value',
    })
  })

  it('url-search-params', async () => {
    const query = new URLSearchParams('foo=bar&bar=baz')

    const [body, headers] = toFetchBody(query, baseHeaders, {})

    expect(body).toBe(query)
    expect(headers).toEqual({
      'x-custom-header': 'custom-value',
    })
  })

  it('blob', () => {
    const blob = new Blob(['foo'], { type: 'application/pdf' })

    generateContentDispositionSpy.mockReturnValue('inline; filename="__mocked__"')

    const [body, headers] = toFetchBody(blob, baseHeaders, {})

    expect(body).toBe(blob)
    expect(headers).toEqual({
      'content-disposition': 'inline; filename="__mocked__"',
      'content-length': '3',
      'content-type': 'application/pdf',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })

    expect(generateContentDispositionSpy).toHaveBeenCalledTimes(1)
    expect(generateContentDispositionSpy).toHaveBeenCalledWith('blob')
  })

  it('empty blob without content-type', () => {
    const blob = new Blob([])

    generateContentDispositionSpy.mockReturnValue('inline; filename="__mocked__"')

    const [body, headers] = toFetchBody(blob, baseHeaders, {})

    expect(body).toBe(blob)
    expect(headers).toEqual({
      'content-disposition': 'inline; filename="__mocked__"',
      'content-length': '0',
      'content-type': '',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })
  })

  it('file', () => {
    const blob = new File(['foo'], 'foo.pdf', { type: 'application/pdf' })

    generateContentDispositionSpy.mockReturnValue('inline; filename="__mocked__"')

    const [body, headers] = toFetchBody(blob, baseHeaders, {})

    expect(body).toBe(blob)
    expect(headers).toEqual({
      'content-disposition': 'inline; filename="__mocked__"',
      'content-length': '3',
      'content-type': 'application/pdf',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })

    expect(generateContentDispositionSpy).toHaveBeenCalledTimes(1)
    expect(generateContentDispositionSpy).toHaveBeenCalledWith('foo.pdf')
  })

  it('file with existing content-disposition header', () => {
    const blob = new File(['foo'], 'foo.pdf', { type: 'application/pdf' })

    const [body, headers] = toFetchBody(
      blob,
      { ...baseHeaders, 'content-disposition': 'attachment; filename="bar.pdf"' },
      {},
    )

    expect(body).toBe(blob)
    expect(headers).toEqual({
      'content-disposition': 'attachment; filename="bar.pdf"',
      'content-length': '3',
      'content-type': 'application/pdf',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })

    expect(generateContentDispositionSpy).toHaveBeenCalledTimes(0)
  })

  it('file with existing content-type header', async () => {
    const file = new File(['<script>alert(1)</script>'], 'foo.html', { type: 'text/html' })

    generateContentDispositionSpy.mockReturnValue('inline; filename="__mocked__"')

    const [body, headers] = toFetchBody(
      file,
      { ...baseHeaders, 'content-type': 'application/octet-stream' },
      {},
    )

    expect(body).toBe(file)
    expect(headers).toEqual({
      'content-disposition': 'inline; filename="__mocked__"',
      'content-length': '25',
      'content-type': 'application/octet-stream',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })

    const response = new Response(body, { headers: toFetchHeaders(headers) })
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(await response.text()).toBe('<script>alert(1)</script>')
  })

  it('file with removed content-type header', () => {
    const file = new File(['foo'], 'foo.html', { type: 'text/html' })

    const [body, headers] = toFetchBody(file, { ...baseHeaders, 'content-type': [] }, {})

    expect(body).toBe(file)
    expect(headers['content-type']).toEqual([])
  })

  it('file with size=nan', () => {
    // BunS3 is a File instance but has an unknown size (NaN), so to support it we should return a stream in this case.
    const file = new File(['foo'], 'foo.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'size', { value: Number.NaN })

    generateContentDispositionSpy.mockReturnValue('inline; filename="__mocked__"')
    const [body, headers] = toFetchBody(file, baseHeaders, {})

    expect(body).toBeInstanceOf(ReadableStream)
    expect(headers).toEqual({
      'content-disposition': 'inline; filename="__mocked__"',
      'content-type': 'application/pdf',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })
  })

  it('event stream', async () => {
    async function* gen() {
      yield 123
      return 456
    }
    const options = { eventStream: { keepAlive: { enabled: false } } }
    const [body, headers] = toFetchBody(gen(), baseHeaders, options)

    expect(toEventStreamSpy).toHaveBeenCalledWith(gen(), options.eventStream)

    expect(body).toBeInstanceOf(ReadableStream)
    expect(headers).toEqual({
      'content-type': 'text/event-stream',
      'x-custom-header': 'custom-value',
    })

    const reader = (body as ReadableStream).pipeThrough(new TextDecoderStream()).getReader()

    expect(await reader.read()).toEqual({ done: false, value: ': \n\n' })
    expect(await reader.read()).toEqual({ done: false, value: 'data: 123\n\n' })
    expect(await reader.read()).toEqual({ done: false, value: 'event: close\ndata: 456\n\n' })
  })

  it('octet stream', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('order1'))
        controller.enqueue(new TextEncoder().encode('order2'))
        controller.enqueue(new TextEncoder().encode('order3'))
        controller.close()
      },
    })
    const [body, headers] = toFetchBody(stream, baseHeaders, {})

    expect(body).toBe(stream)
    expect(headers).toEqual({
      'content-type': 'application/octet-stream',
      'x-custom-header': 'custom-value',
      'standard-server': 'octet-stream',
    })

    const reader = (body as ReadableStream).pipeThrough(new TextDecoderStream()).getReader()

    expect(await reader.read()).toEqual({ done: false, value: 'order1' })
    expect(await reader.read()).toEqual({ done: false, value: 'order2' })
    expect(await reader.read()).toEqual({ done: false, value: 'order3' })
    expect(await reader.read()).toEqual({ done: true })
  })
})

/**
 * These tests ensure that even in environments where the client or server cannot access
 * the 'standard-server' header, the body can be parsed correctly (in case content headers are not touched).
 * We not expect body can parse correctly in most cases, but >= 90% of the time it should work.
 */
it.each([
  {
    name: 'none',
    createBody: () => undefined,
  },
  {
    name: 'json',
    createBody: () => ({ foo: 'bar' }),
  },
  {
    name: 'form-data',
    createBody: () => {
      const form = new FormData()
      form.append('foo', 'bar')
      form.append('bar', 'baz')
      form.append('file', new File(['foo'], 'foo.pdf', { type: 'application/pdf' }))
      return form
    },
    assertBody: async (value: any) => {
      expect(value).toBeInstanceOf(FormData)

      const form = value as FormData
      expect([...form.keys()]).toEqual(['foo', 'bar', 'file'])
      expect(form.getAll('foo')).toEqual(['bar'])
      expect(form.getAll('bar')).toEqual(['baz'])
      const files = form.getAll('file')

      expect(files.length).toEqual(1)
      const file = files[0] as File
      expect(file).toBeInstanceOf(File)
      expect(file.name).toEqual('foo.pdf')
      expect(file.type).toEqual('application/pdf')
      expect(await file.text()).toEqual('foo')
    },
  },
  {
    name: 'url-search-params',
    createBody: () => new URLSearchParams('foo=bar&bar=baz'),
  },
  {
    name: 'blob',
    createBody: () => new Blob(['foo'], { type: 'application/pdf' }),
    assertBody: async (blob: any) => {
      expect(blob).toBeInstanceOf(Blob)
      expect(blob.type).toBe('application/pdf')
      expect(blob.size).toBe(3)
    },
  },
  {
    name: 'file',
    createBody: () => new File(['foo'], 'foo.pdf', { type: 'application/pdf' }),
    assertBody: async (file: any) => {
      expect(file).toBeInstanceOf(File)
      expect(file.name).toEqual('foo.pdf')
      expect(file.type).toEqual('application/pdf')
      expect(await file.text()).toEqual('foo')
    },
  },
  {
    name: 'event-stream',
    createBody: async function* gen() {
      yield 'order 1'
      yield { order: 2 }
      return { order: 3 }
    },
    assertBody: async (iterator: any) => {
      expect(iterator).toSatisfy(isAsyncIteratorObject)

      await expect(iterator.next()).resolves.toEqual({ value: 'order 1', done: false })
      await expect(iterator.next()).resolves.toEqual({ value: { order: 2 }, done: false })
      await expect(iterator.next()).resolves.toEqual({ value: { order: 3 }, done: true })
    },
  },
  {
    name: 'octet-stream',
    createBody: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('order1'))
          controller.enqueue(new TextEncoder().encode('order2'))
          controller.enqueue(new TextEncoder().encode('order3'))
          controller.close()
        },
      }),
    assertBody: async (iterator: any) => {
      expect(iterator).toBeInstanceOf(ReadableStream)
      const reader = iterator.getReader()
      await expect(reader.read()).resolves.toEqual({
        value: new TextEncoder().encode('order1'),
        done: false,
      })
      await expect(reader.read()).resolves.toEqual({
        value: new TextEncoder().encode('order2'),
        done: false,
      })
      await expect(reader.read()).resolves.toEqual({
        value: new TextEncoder().encode('order3'),
        done: false,
      })
      await expect(reader.read()).resolves.toEqual({ value: undefined, done: true })
    },
  },
])(
  'toFetchBody + toStandardBody without standard-server header: $name',
  async ({ name, createBody, assertBody }) => {
    const [body, headers] = toFetchBody(createBody(), {})
    const standardBody = await toStandardBody(
      new Response(body, {
        headers: toFetchHeaders({ ...headers, 'standard-server': undefined }), // delete standard-server header
      }),
    )

    if (assertBody) {
      await assertBody(standardBody)
    } else {
      expect(standardBody).toEqual(createBody())
    }
  },
)
