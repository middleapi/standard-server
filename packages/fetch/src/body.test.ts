import * as StandardServerModule from '@standard-server/core'
import { isAsyncIteratorObject, PayloadTooLargeError } from '@standard-server/shared'

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

const MULTIPART_HEAD = '--X\r\nContent-Disposition: form-data; name="a"\r\n\r\n'
const MULTIPART_TAIL = '\r\n--X--\r\n'

/**
 * How to build and read back a valid body for each hint `maxBodySize` applies to,
 * around a payload of `x`s.
 */
const LIMITED_BODIES = {
  'json': {
    contentType: 'application/json',
    overhead: 2,
    create: (payload: string) => JSON.stringify(payload),
    read: async (body: any): Promise<string> => body,
  },
  'url-search-params': {
    contentType: 'application/x-www-form-urlencoded',
    overhead: 2,
    create: (payload: string) => `a=${payload}`,
    read: async (body: any): Promise<string> => body.get('a'),
  },
  'form-data': {
    contentType: 'multipart/form-data; boundary=X',
    overhead: MULTIPART_HEAD.length + MULTIPART_TAIL.length,
    create: (payload: string) => `${MULTIPART_HEAD}${payload}${MULTIPART_TAIL}`,
    read: async (body: any): Promise<string> => body.get('a'),
  },
  'file': {
    contentType: 'application/pdf',
    overhead: 0,
    create: (payload: string) => payload,
    read: async (body: any): Promise<string> => body.text(),
  },
} as const

type LimitedHint = keyof typeof LIMITED_BODIES

const LIMITED_HINTS = Object.keys(LIMITED_BODIES) as LimitedHint[]

function limitedHeaders(hint: LimitedHint): Record<string, string> {
  return { 'standard-server': hint, 'content-type': LIMITED_BODIES[hint].contentType }
}

/**
 * A valid body of exactly `size` bytes for the hint, so only its size decides whether it parses.
 */
function createLimitedBody(hint: LimitedHint, size: number): Uint8Array {
  const fixture = LIMITED_BODIES[hint]
  return new TextEncoder().encode(fixture.create('x'.repeat(size - fixture.overhead)))
}

async function expectLimitedBody(hint: LimitedHint, body: unknown, size: number): Promise<void> {
  const fixture = LIMITED_BODIES[hint]
  expect(await fixture.read(body)).toBe('x'.repeat(size - fixture.overhead))
}

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

  describe('maxBodySize', () => {
    const LIMIT = 1024
    const CHUNK_SIZE = 256

    /**
     * A request streaming `body` in chunks as they're read, counting the bytes read from it.
     */
    function createStreamingRequest(
      headers: Record<string, string>,
      body: Uint8Array,
    ): [request: Request, bytesRead: () => number, cancel: ReturnType<typeof vi.fn>] {
      let bytesRead = 0
      const cancel = vi.fn()

      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const chunk = body.subarray(bytesRead, bytesRead + CHUNK_SIZE)
            bytesRead += chunk.length

            if (chunk.length > 0) {
              controller.enqueue(chunk)
            } else {
              controller.close()
            }
          },
          cancel,
        },
        { highWaterMark: 0 }, // no read-ahead, so `bytesRead` is what the parser read
      )

      const request = new Request('https://example.com', {
        method: 'POST',
        body: stream,
        headers,
        duplex: 'half',
      })

      return [request, () => bytesRead, cancel]
    }

    describe.each(LIMITED_HINTS)('%s', (hint) => {
      it('rejects a larger streamed body, reading at most one chunk past the limit', async () => {
        const [request, bytesRead, cancel] = createStreamingRequest(
          limitedHeaders(hint),
          createLimitedBody(hint, 4096),
        )

        const result = toStandardBody(request, { maxBodySize: LIMIT })

        await expect(result).rejects.toBeInstanceOf(PayloadTooLargeError)
        await expect(result).rejects.toThrow('Body exceeds the size limit of 1024 bytes')
        expect(bytesRead()).toBeLessThanOrEqual(LIMIT + CHUNK_SIZE)
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(cancel).toHaveBeenCalledWith(expect.any(PayloadTooLargeError))
      })

      it('rejects a larger content-length before reading', async () => {
        const [request, bytesRead, cancel] = createStreamingRequest(
          { ...limitedHeaders(hint), 'content-length': '4096' },
          createLimitedBody(hint, 4096),
        )

        await expect(toStandardBody(request, { maxBodySize: LIMIT })).rejects.toBeInstanceOf(
          PayloadTooLargeError,
        )
        expect(bytesRead()).toBe(0)
        expect(cancel).not.toHaveBeenCalled()
        expect(request.bodyUsed).toBe(false)
      })

      it('rejects a larger non-stream body', async () => {
        const request = new Request('https://example.com', {
          method: 'POST',
          body: createLimitedBody(hint, 4096),
          headers: limitedHeaders(hint),
        })

        await expect(toStandardBody(request, { maxBodySize: LIMIT })).rejects.toBeInstanceOf(
          PayloadTooLargeError,
        )
      })

      it.each([512, LIMIT])('parses a %d-byte body', async (size) => {
        const body = createLimitedBody(hint, size)

        const [streamed] = createStreamingRequest(limitedHeaders(hint), body)
        await expectLimitedBody(hint, await toStandardBody(streamed, { maxBodySize: LIMIT }), size)

        const [sized] = createStreamingRequest(
          { ...limitedHeaders(hint), 'content-length': String(size) },
          body,
        )
        await expectLimitedBody(hint, await toStandardBody(sized, { maxBodySize: LIMIT }), size)
      })
    })

    it('keeps the file name and type', async () => {
      const [request] = createStreamingRequest(
        {
          'standard-server': 'file',
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="foo.pdf"',
        },
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      )

      const file = (await toStandardBody(request, { maxBodySize: LIMIT })) as File

      expect(file).toBeInstanceOf(File)
      expect(file.name).toBe('foo.pdf')
      expect(file.type).toBe('application/pdf')
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      )
    })

    it('returns undefined for a json response without a body', async () => {
      const response = new Response(null, {
        headers: {
          'content-type': 'application/json',
        },
      })

      expect(await toStandardBody(response, { maxBodySize: LIMIT })).toBe(undefined)
    })

    it('does not limit the streamed hints', async () => {
      const [octetStream] = createStreamingRequest(
        { 'standard-server': 'octet-stream', 'content-length': '4096' },
        new TextEncoder().encode('x'.repeat(4096)),
      )
      const stream = await toStandardBody(octetStream, { maxBodySize: LIMIT })

      expect(stream).toBeInstanceOf(ReadableStream)
      expect(await new Response(stream as ReadableStream).text()).toBe('x'.repeat(4096))

      const event = `data: "${'x'.repeat(4096)}"\n\n`
      const [eventStream] = createStreamingRequest(
        { 'standard-server': 'event-stream', 'content-length': String(event.length) },
        new TextEncoder().encode(event),
      )
      const iterator = (await toStandardBody(eventStream, { maxBodySize: LIMIT })) as any

      expect(iterator).toSatisfy(isAsyncIteratorObject)
      expect(await iterator.next()).toEqual({ done: false, value: 'x'.repeat(4096) })
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
