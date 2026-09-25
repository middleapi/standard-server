import type { StandardBody } from '@standard-server/core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NodeHttpRequest } from './types'
import { Buffer } from 'node:buffer'
import http2 from 'node:http2'
import { Readable } from 'node:stream'
import * as StandardServerModule from '@standard-server/core'
import { toFetchHeaders } from '@standard-server/fetch'
import { isAsyncIteratorObject } from '@standard-server/shared'
import request from 'supertest'
import { toNodeHttpBody, toStandardBody } from './body'
import * as EventStreamModule from './event-stream'
import * as UtilsModule from './utils'

const toEventStreamSpy = vi.spyOn(EventStreamModule, 'toEventStream')
const toWebReadableStreamSpy = vi.spyOn(UtilsModule, 'toWebReadableStream')
const generateContentDispositionSpy = vi.spyOn(StandardServerModule, 'generateContentDisposition')
const getFilenameFromContentDispositionSpy = vi.spyOn(StandardServerModule, 'getFilenameFromContentDisposition')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('toStandardBody', () => {
  it('json but empty body', async () => {
    let standardBody: StandardBody = {} as any

    await request(async (req: IncomingMessage, res: ServerResponse) => {
      standardBody = await toStandardBody(req)
      res.end()
    }).post('/').type('application/json').send('')

    expect(standardBody).toEqual(undefined)
  })

  it('file', async () => {
    let standardBody: any

    getFilenameFromContentDispositionSpy.mockReturnValueOnce('__name__')

    await request(async (req: IncomingMessage, res: ServerResponse) => {
      standardBody = await toStandardBody(req)
      res.end()
    })
      .delete('/')
      .type('plain/text')
      .set('content-disposition', 'attachment; filename="foo.pdf"')
      .send('{"value":123}')

    expect(standardBody).toBeInstanceOf(File)
    expect(standardBody.name).toBe('__name__')
    expect(standardBody.type).toBe('plain/text')
    expect(await standardBody.text()).toBe('{"value":123}')

    expect(getFilenameFromContentDispositionSpy).toHaveBeenCalledTimes(1)
    expect(getFilenameFromContentDispositionSpy).toHaveBeenCalledWith('attachment; filename="foo.pdf"')
  })

  describe('body hint', () => {
    it('undefined', async () => {
      let standardBody: StandardBody

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        standardBody = await toStandardBody(req)
        res.end()
      })
        .post('/')
        .set('standard-server', 'none')
        .send('body')

      expect(standardBody).toBe(undefined)
    })

    it('json', async () => {
      let standardBody: StandardBody = {} as any

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        standardBody = await toStandardBody(req)
        res.end()
      })
        .post('/')
        .set('standard-server', 'json')
        .send('{"foo":"bar"}')

      expect(standardBody).toEqual({ foo: 'bar' })
    })

    it('async iterator object', async () => {
      let standardBody: any

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        standardBody = await toStandardBody(req)
        res.end()
      })
        .delete('/')
        .set('standard-server', 'event-stream')
        .send('event: message\ndata: 123\n\nevent: close\ndata: 456\n\n')

      expect(standardBody).toSatisfy(isAsyncIteratorObject)
      expect(await standardBody.next()).toEqual({ done: false, value: 123 })
      expect(await standardBody.next()).toEqual({ done: true, value: 456 })
    })

    it('form-data', async () => {
      let standardBody: any

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        standardBody = await toStandardBody(req)
        res.end()
      })
        .delete('/')
        .set('standard-server', 'form-data')
        .field('foo', 'bar')
        .field('bar', 'baz')

      expect(standardBody).toBeInstanceOf(FormData)
      expect(standardBody.get('foo')).toBe('bar')
      expect(standardBody.get('bar')).toBe('baz')
    })

    it('url-search-params', async () => {
      let standardBody: any

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        standardBody = await toStandardBody(req)
        res.end()
      })
        .delete('/')
        .set('standard-server', 'url-search-params')
        .send('foo=bar&bar=baz')

      expect(standardBody).toEqual(new URLSearchParams('foo=bar&bar=baz'))
    })

    it('file/blob', async () => {
      let standardBody: any

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        standardBody = await toStandardBody(req)
        res.end()
      })
        .post('/')
        .set('standard-server', 'file')
        .send('foo')

      expect(standardBody).toBeInstanceOf(File)
      expect(await standardBody.text()).toBe('foo')
    })

    it('prefer parsed body', async () => {
      let standardBody: StandardBody = {} as any

      await request(async (req: IncomingMessage, res: ServerResponse) => {
      // @ts-expect-error fake body is parsed
        req.body = { value: 123 }
        standardBody = await toStandardBody(req)
        res.end()
      })
        .post('/')
        .set('standard-server', 'file')
        .send(Buffer.from('foo'))

      expect(standardBody).toEqual({ value: 123 })
    })
  })

  describe('handle utf-8 characters split across stream chunks', () => {
    function createChunkedIncomingMessage(method: string, contentType: string, chunks: Buffer[]): IncomingMessage {
      const request = Readable.from(chunks) as IncomingMessage
      request.method = method
      request.headers = {
        'content-type': contentType,
      }
      return request
    }

    it('json: 4-byte emoji split after first byte', async () => {
      const bytes = Buffer.from('{"emoji":"😀"}', 'utf-8')
      const splitAt = Buffer.from('{"emoji":"').length + 1 // one byte into the emoji codepoint
      const chunks = [bytes.subarray(0, splitAt), bytes.subarray(splitAt)]

      const incomingMessage = createChunkedIncomingMessage('POST', 'application/json', chunks)
      const result = await toStandardBody(incomingMessage)
      expect(result).toEqual({ emoji: '😀' })
    })

    it('url-search-params: 4-byte emoji split after first byte', async () => {
      const bytes = Buffer.from('emoji=😀', 'utf-8')
      const splitAt = Buffer.from('emoji=').length + 1 // one byte into the emoji codepoint
      const chunks = [bytes.subarray(0, splitAt), bytes.subarray(splitAt)]

      const incomingMessage = createChunkedIncomingMessage('POST', 'application/x-www-form-urlencoded', chunks)
      const result = await toStandardBody(incomingMessage)
      expect(result).toEqual(new URLSearchParams('emoji=😀'))
    })

    it('url-search-params: end with incomplete 4-byte emoji', async () => {
      const bytes = Buffer.from('emoji=😀', 'utf-8')
      const chunks = [bytes.subarray(0, bytes.length - 1)] // emoji missing last byte

      const incomingMessage = createChunkedIncomingMessage('POST', 'application/x-www-form-urlencoded', chunks)
      const result = await toStandardBody(incomingMessage)
      expect(result).toEqual(new URLSearchParams('emoji=�'))
    })
  })

  describe('http2', () => {
    /**
     * Runs a request through a real http2 server, so `toStandardBody` receives an
     * `Http2ServerRequest` instead of an `IncomingMessage`.
     */
    async function http2Roundtrip(
      onTestFinished: (fn: () => Promise<any>) => void,
      headers: Record<string, string>,
      body: Buffer,
    ): Promise<[standardBody: StandardBody, streamedBytes: Uint8Array | undefined]> {
      let standardBody: StandardBody
      let streamedBytes: Uint8Array | undefined
      let error: unknown

      const server = http2.createServer(async (req, res) => {
        try {
          standardBody = await toStandardBody(req)

          // a streaming body must be drained while the request is still alive
          if (standardBody instanceof ReadableStream) {
            streamedBytes = new Uint8Array(await new Response(standardBody).arrayBuffer())
          }
        }
        catch (e) {
          error = e
        }
        res.end()
      })
      onTestFinished(() => new Promise<any>(r => server.close(r)))

      await new Promise<void>(r => server.listen(0, r))
      const port = (server.address() as any).port

      const client = http2.connect(`http://localhost:${port}`)
      onTestFinished(async () => client.close())

      await new Promise<void>((resolve) => {
        const stream = client.request({ ':method': 'POST', ':path': '/', ...headers })
        stream.end(body)
        stream.on('response', () => {
          stream.resume()
          stream.on('end', () => resolve())
        })
      })

      if (error !== undefined) {
        throw error
      }

      return [standardBody!, streamedBytes]
    }

    it('json', async ({ onTestFinished }) => {
      const [result] = await http2Roundtrip(
        onTestFinished,
        { 'content-type': 'application/json' },
        Buffer.from('{"emoji":"😀"}'),
      )

      expect(result).toEqual({ emoji: '😀' })
    })

    it('url-search-params', async ({ onTestFinished }) => {
      const [result] = await http2Roundtrip(
        onTestFinished,
        { 'content-type': 'application/x-www-form-urlencoded' },
        Buffer.from('emoji=😀'),
      )

      expect(result).toEqual(new URLSearchParams('emoji=😀'))
    })

    it('form-data', async ({ onTestFinished }) => {
      const [result] = await http2Roundtrip(
        onTestFinished,
        { 'content-type': 'multipart/form-data; boundary=X' },
        Buffer.from('--X\r\nContent-Disposition: form-data; name="emoji"\r\n\r\n😀\r\n--X--\r\n'),
      ) as [FormData, undefined]

      expect(result).toBeInstanceOf(FormData)
      expect(result.get('emoji')).toBe('😀')
    })

    it('file', async ({ onTestFinished }) => {
      const body = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF])

      const [result] = await http2Roundtrip(onTestFinished, {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="foo.pdf"',
      }, body) as [File, undefined]

      expect(result).toBeInstanceOf(File)
      expect(result.name).toBe('foo.pdf')
      expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array(body))
    })

    it('octet-stream', async ({ onTestFinished }) => {
      const body = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF])

      const [result, streamedBytes] = await http2Roundtrip(
        onTestFinished,
        { 'content-type': 'application/octet-stream' },
        body,
      )

      expect(result).toBeInstanceOf(ReadableStream)
      expect(streamedBytes).toEqual(new Uint8Array(body))
      expect(toWebReadableStreamSpy).toHaveBeenCalledTimes(1)
      expect(result).toBe(toWebReadableStreamSpy.mock.results[0]!.value)
    })
  })

  describe('edge case', () => {
    it('throw on read body multiple time except (hint=none)', async () => {
      let req: NodeHttpRequest

      await request(async (_req: IncomingMessage, res: ServerResponse) => {
        req = _req as NodeHttpRequest
        // first read
        await toStandardBody(req)
        res.end()
      })
        .post('/')
        .send({ foo: 'bar' })

      await expect(toStandardBody(req!)).rejects.toThrow('Failed to read body: body stream already read')
      expect(await toStandardBody(req!, { hint: 'none' })).toBe(undefined)
    })

    it('prefers user defined body hint over standard-server header', async () => {
      let standardBody: any

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        standardBody = await toStandardBody(req, { hint: 'octet-stream' })
        res.end()
      })
        .post('/')
        .set('content-length', '567')
        .set('standard-server', 'file') // low priority
        .send('hello')

      expect(standardBody).toBeInstanceOf(ReadableStream)
      expect(toWebReadableStreamSpy).toHaveBeenCalledTimes(1)
      expect(standardBody).toBe(toWebReadableStreamSpy.mock.results[0]!.value)
      const reader = (standardBody as ReadableStream).pipeThrough(new TextDecoderStream()).getReader()
      expect(await reader.read()).toEqual({ done: false, value: 'hello' })
    })

    it('falls back to the content headers if the body hint is invalid', async () => {
      let standardBody: any

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        standardBody = await toStandardBody(req)
        res.end()
      })
        .post('/')
        .set('standard-server', 'invalid')
        .send('raw data')

      // superagent sends a string body as url-encoded
      expect(standardBody).toEqual(new URLSearchParams('raw data'))
    })
  })
})

describe('toNodeHttpBody', () => {
  const baseHeaders = {
    'x-custom-header': 'custom-value',
  }

  it('undefined', async () => {
    const [body, headers] = toNodeHttpBody(undefined, baseHeaders, {})

    expect(body).toBe(undefined)
    expect(headers).toEqual({
      'x-custom-header': 'custom-value',
    })
  })

  it('json', async () => {
    const [body, headers] = toNodeHttpBody({ foo: 'bar' }, baseHeaders, {})

    expect(body).toBe('{"foo":"bar"}')
    expect(headers).toEqual({
      'content-type': 'application/json',
      'x-custom-header': 'custom-value',
    })
  })

  it('form-data', async () => {
    const form = new FormData()
    form.append('foo', 'bar')
    form.append('bar', 'baz')

    const [body, headers] = toNodeHttpBody(form, baseHeaders, {})

    expect(body).toBeInstanceOf(Readable)
    expect(headers).toEqual({
      'x-custom-header': 'custom-value',
      'content-type': expect.stringMatching(/multipart\/form-data;.+/),
    })

    const response = new Response(body, {
      headers: toFetchHeaders(headers),
    })
    const resForm = await response.formData()

    expect(resForm.get('foo')).toBe('bar')
    expect(resForm.get('bar')).toBe('baz')
  })

  it('url-search-params', async () => {
    const query = new URLSearchParams('foo=bar&bar=baz')

    const [body, headers] = toNodeHttpBody(query, baseHeaders, {})

    expect(body).toBe('foo=bar&bar=baz')
    expect(headers).toEqual({
      'x-custom-header': 'custom-value',
      'content-type': 'application/x-www-form-urlencoded',
    })
  })

  it('blob', async () => {
    const blob = new Blob(['foo'], { type: 'application/pdf' })

    generateContentDispositionSpy.mockReturnValue('inline; filename="__mocked__"')

    const [body, headers] = toNodeHttpBody(blob, baseHeaders, {})

    expect(body).toBeInstanceOf(Readable)
    expect(headers).toEqual({
      'content-disposition': 'inline; filename="__mocked__"',
      'content-length': '3',
      'content-type': 'application/pdf',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })

    expect(generateContentDispositionSpy).toHaveBeenCalledTimes(1)
    expect(generateContentDispositionSpy).toHaveBeenCalledWith('blob')

    const response = new Response(body, {
      headers: toFetchHeaders(headers),
    })
    const resBlob = await response.blob()

    expect(resBlob.type).toBe('application/pdf')
    expect(await resBlob.text()).toBe('foo')
  })

  it('file', async () => {
    const blob = new File(['foo'], 'foo.pdf', { type: 'application/pdf' })

    generateContentDispositionSpy.mockReturnValue('inline; filename="__mocked__"')

    const [body, headers] = toNodeHttpBody(blob, baseHeaders, {})

    expect(body).instanceOf(Readable)
    expect(headers).toEqual({
      'content-disposition': 'inline; filename="__mocked__"',
      'content-length': '3',
      'content-type': 'application/pdf',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })

    expect(generateContentDispositionSpy).toHaveBeenCalledTimes(1)
    expect(generateContentDispositionSpy).toHaveBeenCalledWith('foo.pdf')

    const response = new Response(body, {
      headers: toFetchHeaders(headers),
    })
    const resBlob = await response.blob()

    expect(resBlob.type).toBe('application/pdf')
    expect(await resBlob.text()).toBe('foo')
  })

  it('file with existing content-disposition headers', async () => {
    const headersBase = { ...baseHeaders, 'content-disposition': 'attachment; filename="foo.pdf"' }
    const blob = new File(['foo'], 'foo.pdf', { type: 'application/pdf' })

    const [body, headers] = toNodeHttpBody(blob, headersBase, {})

    expect(body).instanceOf(Readable)
    expect(headers).toEqual({
      'content-disposition': 'attachment; filename="foo.pdf"',
      'content-length': '3',
      'content-type': 'application/pdf',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })

    expect(generateContentDispositionSpy).toHaveBeenCalledTimes(0)

    const response = new Response(body, {
      headers: toFetchHeaders(headers),
    })
    const resBlob = await response.blob()

    expect(resBlob.type).toBe('application/pdf')
    expect(await resBlob.text()).toBe('foo')
  })

  it('empty blob without content-type', async () => {
    const blob = new Blob([])

    generateContentDispositionSpy.mockReturnValue('inline; filename="__mocked__"')

    const [body, headers] = toNodeHttpBody(blob, baseHeaders, {})

    expect(body).toBeInstanceOf(Readable)
    expect(headers).toEqual({
      'content-disposition': 'inline; filename="__mocked__"',
      'content-length': '0',
      'content-type': '',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })
  })

  it('file with size=nan', async () => {
    const file = new File(['foo'], 'foo.pdf', { type: 'application/pdf' })
    Object.defineProperty(file, 'size', { value: Number.NaN })

    generateContentDispositionSpy.mockReturnValue('inline; filename="__mocked__"')

    const [body, headers] = toNodeHttpBody(file, baseHeaders, {})

    expect(body).toBeInstanceOf(Readable)
    expect(headers).toEqual({
      'content-disposition': 'inline; filename="__mocked__"',
      'content-length': undefined,
      'content-type': 'application/pdf',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })

    expect(generateContentDispositionSpy).toHaveBeenCalledTimes(1)
    expect(generateContentDispositionSpy).toHaveBeenCalledWith('foo.pdf')
  })

  it('file with undefined name (Bun compatibility)', async () => {
    // Bun returns `undefined` for an empty File name
    const file = new File(['foo'], '', { type: 'application/pdf' })
    Object.defineProperty(file, 'name', { value: undefined })

    generateContentDispositionSpy.mockReturnValue('inline; filename="__mocked__"')

    const [body, headers] = toNodeHttpBody(file, baseHeaders, {})

    expect(body).toBeInstanceOf(Readable)
    expect(headers['content-disposition']).toBe('inline; filename="__mocked__"')
    expect(generateContentDispositionSpy).toHaveBeenCalledTimes(1)
    expect(generateContentDispositionSpy).toHaveBeenCalledWith('')
  })

  it('event stream', async () => {
    async function* gen() {
      yield 123
      return 456
    }
    const options = { eventStream: { keepAlive: { enabled: true } } }
    const iterator = gen()
    const [body, headers] = toNodeHttpBody(iterator, baseHeaders, options)

    expect(toEventStreamSpy).toHaveBeenCalledWith(iterator, options.eventStream)

    expect(body).toBeInstanceOf(Readable)
    expect(headers).toEqual({
      'content-type': 'text/event-stream',
      'x-custom-header': 'custom-value',
    })

    const reader = Readable.toWeb((body as Readable)).pipeThrough(new TextDecoderStream()).getReader()

    expect(await reader.read()).toEqual({ done: false, value: ': \n\n' })
    expect(await reader.read()).toEqual({ done: false, value: 'event: message\ndata: 123\n\n' })
    expect(await reader.read()).toEqual({ done: false, value: 'event: close\ndata: 456\n\n' })
    expect(await reader.read()).toEqual({ done: true })
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
    const [body, headers] = toNodeHttpBody(stream, baseHeaders)

    expect(body).toBeInstanceOf(Readable)
    expect(headers).toEqual({
      'content-type': 'application/octet-stream',
      'x-custom-header': 'custom-value',
      'standard-server': 'octet-stream',
    })

    const reader = Readable.toWeb((body as Readable)).pipeThrough(new TextDecoderStream()).getReader()

    expect(await reader.read()).toEqual({ done: false, value: 'order1' })
    expect(await reader.read()).toEqual({ done: false, value: 'order2' })
    expect(await reader.read()).toEqual({ done: false, value: 'order3' })
    expect(await reader.read()).toEqual({ done: true })
  })

  describe('override auto-set headers with empty array', () => {
    it('readable stream: unset content-type, and standard-server', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'))
          controller.close()
        },
      })
      const [body, headers] = toNodeHttpBody(stream, {
        ...baseHeaders,
        'content-type': [],
        'standard-server': [],
      })

      expect(body).toBeInstanceOf(Readable)
      expect(headers).toEqual({
        'content-type': [],
        'x-custom-header': 'custom-value',
        'standard-server': [],
      })

      const fetchHeaders = toFetchHeaders(headers)
      expect(fetchHeaders.has('content-type')).toBe(false)
      expect(fetchHeaders.has('standard-server')).toBe(false)
    })

    it('blob: unset standard-server, and content-disposition', async () => {
      const blob = new Blob(['foo'], { type: 'application/pdf' })
      const [body, headers] = toNodeHttpBody(blob, {
        ...baseHeaders,
        'standard-server': [],
        'content-disposition': [],
      })

      expect(body).toBeInstanceOf(Readable)
      expect(headers).toEqual({
        'content-length': '3',
        'content-type': 'application/pdf',
        'x-custom-header': 'custom-value',
        'standard-server': [],
        'content-disposition': [],
      })

      const fetchHeaders = toFetchHeaders(headers)
      expect(fetchHeaders.has('standard-server')).toBe(false)
      expect(fetchHeaders.has('content-disposition')).toBe(false)
    })
  })
})
