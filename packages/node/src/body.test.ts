import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'

import type { StandardBody } from '@standard-server/core'
import * as StandardServerModule from '@standard-server/core'
import { toFetchHeaders } from '@standard-server/fetch'
import { isAsyncIteratorObject, PayloadTooLargeError } from '@standard-server/shared'
import request from 'supertest'

import type { ToStandardBodyOptions } from './body'
import { toNodeHttpBody, toStandardBody } from './body'
import * as EventStreamModule from './event-stream'
import type { NodeHttpRequest } from './types'
import * as UtilsModule from './utils'

const toEventStreamSpy = vi.spyOn(EventStreamModule, 'toEventStream')
const toWebReadableStreamSpy = vi.spyOn(UtilsModule, 'toWebReadableStream')
const generateContentDispositionSpy = vi.spyOn(StandardServerModule, 'generateContentDisposition')
const getFilenameFromContentDispositionSpy = vi.spyOn(
  StandardServerModule,
  'getFilenameFromContentDisposition',
)

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * How to build and read back a valid body for each hint `maxBodySize` applies to,
 * around a payload of `x`s.
 */
const LIMITED_BODIES = {
  'json': {
    contentType: 'application/json',
    create: (payload: string) => JSON.stringify(payload),
    read: async (body: any): Promise<string> => body,
  },
  'url-search-params': {
    contentType: 'application/x-www-form-urlencoded',
    create: (payload: string) => `a=${payload}`,
    read: async (body: any): Promise<string> => body.get('a'),
  },
  'form-data': {
    contentType: 'multipart/form-data; boundary=X',
    create: (payload: string) =>
      `--X\r\nContent-Disposition: form-data; name="a"\r\n\r\n${payload}\r\n--X--\r\n`,
    read: async (body: any): Promise<string> => body.get('a'),
  },
  'file': {
    contentType: 'application/pdf',
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
 * The payload that pads the hint's body to exactly `size` bytes.
 */
function limitedPayload(hint: LimitedHint, size: number): string {
  return 'x'.repeat(size - LIMITED_BODIES[hint].create('').length)
}

/**
 * A valid body of exactly `size` bytes for the hint, so only its size decides whether it parses.
 */
function createLimitedBody(hint: LimitedHint, size: number): Uint8Array {
  return new TextEncoder().encode(LIMITED_BODIES[hint].create(limitedPayload(hint, size)))
}

async function expectLimitedBody(hint: LimitedHint, body: unknown, size: number): Promise<void> {
  expect(await LIMITED_BODIES[hint].read(body)).toBe(limitedPayload(hint, size))
}

describe('toStandardBody', () => {
  it('json but empty body', async () => {
    let standardBody: StandardBody = {} as any

    await request(async (req: IncomingMessage, res: ServerResponse) => {
      standardBody = await toStandardBody(req)
      res.end()
    })
      .post('/')
      .type('application/json')
      .send('')

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
    expect(getFilenameFromContentDispositionSpy).toHaveBeenCalledWith(
      'attachment; filename="foo.pdf"',
    )
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

    it('json strips a leading BOM', async () => {
      let standardBody: StandardBody = {} as any

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        standardBody = await toStandardBody(req)
        res.end()
      })
        .post('/')
        .set('standard-server', 'json')
        .send('\uFEFF{"foo":"bar"}')

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

    it('url-search-params strips a leading BOM', async () => {
      let standardBody: any

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        standardBody = await toStandardBody(req)
        res.end()
      })
        .post('/')
        .set('standard-server', 'url-search-params')
        .send('\uFEFFfoo=bar')

      expect(standardBody).toEqual(new URLSearchParams('foo=bar'))
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
        // fake an upstream parser: consume the stream, then assign the parsed body
        await text(req)
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

    // body-parser 1.x (express 4) assigns `{}` to every request, even the ones it leaves unread
    it('ignore body assigned without consuming the stream', async () => {
      let standardBody: any

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        // @ts-expect-error fake body is assigned
        req.body = {}
        standardBody = await toStandardBody(req)
        res.end()
      })
        .post('/')
        .set('standard-server', 'file')
        .send(Buffer.from('foo'))

      expect(standardBody).toBeInstanceOf(File)
      expect(await standardBody.text()).toBe('foo')

      await request(async (req: IncomingMessage, res: ServerResponse) => {
        // @ts-expect-error fake body is assigned
        req.body = {}
        standardBody = await toStandardBody(req)
        res.end()
      }).get('/')

      expect(standardBody).toBe(undefined)
    })
  })

  describe('handle utf-8 characters split across stream chunks', () => {
    function createChunkedIncomingMessage(
      method: string,
      contentType: string,
      chunks: Buffer[],
    ): IncomingMessage {
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

      const incomingMessage = createChunkedIncomingMessage(
        'POST',
        'application/x-www-form-urlencoded',
        chunks,
      )
      const result = await toStandardBody(incomingMessage)
      expect(result).toEqual(new URLSearchParams('emoji=😀'))
    })

    it('url-search-params: end with incomplete 4-byte emoji', async () => {
      const bytes = Buffer.from('emoji=😀', 'utf-8')
      const chunks = [bytes.subarray(0, bytes.length - 1)] // emoji missing last byte

      const incomingMessage = createChunkedIncomingMessage(
        'POST',
        'application/x-www-form-urlencoded',
        chunks,
      )
      const result = await toStandardBody(incomingMessage)
      expect(result).toEqual(new URLSearchParams('emoji=�'))
    })
  })

  describe.each(['utf8', 'latin1', 'base64', 'hex'] as const)(
    'request with %s encoding set',
    (encoding) => {
      // utf8 decodes invalid byte sequences to U+FFFD, so only valid text survives it
      const bytes =
        encoding === 'utf8' ? Buffer.from('emoji=😀') : Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41])
      let standardBody: any

      async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
        req.setEncoding(encoding)
        standardBody = await toStandardBody(req)
        res.end()
      }

      it('json', async () => {
        await request(handler).post('/').set('standard-server', 'json').send('{"emoji":"😀"}')

        expect(standardBody).toEqual({ emoji: '😀' })
      })

      it('file', async () => {
        await request(handler).post('/').set('standard-server', 'file').send(bytes)

        expect(standardBody).toBeInstanceOf(File)
        expect(new Uint8Array(await standardBody.arrayBuffer())).toEqual(new Uint8Array(bytes))
      })

      it('form-data', async () => {
        await request(handler).post('/').field('emoji', '😀').attach('file', bytes, 'foo.bin')

        expect(standardBody).toBeInstanceOf(FormData)
        expect(standardBody.get('emoji')).toBe('😀')
        expect(new Uint8Array(await standardBody.get('file').arrayBuffer())).toEqual(
          new Uint8Array(bytes),
        )
      })
    },
  )

  describe('maxBodySize', () => {
    const LIMIT = 1024
    const CHUNK_SIZE = 256

    /**
     * A request streaming `body` in chunks as they're read, counting the bytes read from it.
     * Without a content-length header, it's a chunked upload.
     */
    function createChunkedRequest(
      headers: Record<string, string>,
      body: Uint8Array,
    ): [req: IncomingMessage, bytesRead: () => number] {
      let bytesRead = 0

      const req = new Readable({
        highWaterMark: 0, // no read-ahead, so `bytesRead` is what the parser read
        read() {
          const chunk = body.subarray(bytesRead, bytesRead + CHUNK_SIZE)
          bytesRead += chunk.length
          this.push(chunk.length > 0 ? chunk : null)
        },
      }) as IncomingMessage
      req.headers = headers

      return [req, () => bytesRead]
    }

    describe.each(LIMITED_HINTS)('%s', (hint) => {
      it('rejects a larger chunked body, reading at most one chunk past the limit', async () => {
        const [req, bytesRead] = createChunkedRequest(
          limitedHeaders(hint),
          createLimitedBody(hint, 4096),
        )

        await expect(toStandardBody(req, { maxBodySize: LIMIT })).rejects.toBeInstanceOf(
          PayloadTooLargeError,
        )
        expect(bytesRead()).toBeLessThanOrEqual(LIMIT + CHUNK_SIZE)
        expect(req.destroyed).toBe(true) // not a server request, so it's destroyed, not drained
      })

      it('rejects a larger content-length before reading', async () => {
        const [req, bytesRead] = createChunkedRequest(
          { ...limitedHeaders(hint), 'content-length': '4096' },
          createLimitedBody(hint, 4096),
        )

        await expect(toStandardBody(req, { maxBodySize: LIMIT })).rejects.toBeInstanceOf(
          PayloadTooLargeError,
        )
        expect(bytesRead()).toBe(0)
        expect(req.destroyed).toBe(false)
      })

      it.each([512, LIMIT])('parses a %d-byte body', async (size) => {
        const body = createLimitedBody(hint, size)

        for (const headers of [
          limitedHeaders(hint),
          { ...limitedHeaders(hint), 'content-length': String(size) },
        ]) {
          const [req] = createChunkedRequest(headers, body)
          await expectLimitedBody(hint, await toStandardBody(req, { maxBodySize: LIMIT }), size)
        }
      })

      it('lets an http1 response send a 413 and keep the connection alive', async ({
        onTestFinished,
      }) => {
        const server = createServer(async (req, res) => {
          if (req.method === 'GET') {
            res.end('ok')
            return
          }

          try {
            await toStandardBody(req, { maxBodySize: LIMIT })
            res.end('parsed')
          } catch (error) {
            res.statusCode = (error as PayloadTooLargeError).status
            res.end((error as Error).name)
          }
        })
        onTestFinished(
          () =>
            new Promise<any>((r) => {
              server.closeAllConnections()
              server.close(r)
            }),
        )

        await new Promise<void>((r) => server.listen(0, r))
        const { port } = server.address() as AddressInfo

        const body = createLimitedBody(hint, 4096)
        const headers = Object.entries(limitedHeaders(hint))
          .map(([name, value]) => `${name}: ${value}\r\n`)
          .join('')

        const socket = net.connect(port, '127.0.0.1')

        // chunked, so the limit is hit while reading
        socket.write(`POST / HTTP/1.1\r\nHost: x\r\n${headers}Transfer-Encoding: chunked\r\n\r\n`)
        for (let offset = 0; offset < body.length; offset += CHUNK_SIZE) {
          socket.write(`${CHUNK_SIZE.toString(16)}\r\n`)
          socket.write(body.subarray(offset, offset + CHUNK_SIZE))
          socket.write('\r\n')
        }
        socket.write('0\r\n\r\n')

        // rejected from its content-length before reading
        socket.write(
          `POST / HTTP/1.1\r\nHost: x\r\n${headers}Content-Length: ${body.length}\r\n\r\n`,
        )
        socket.write(body)

        // queued behind the rejected bodies, so it's only answered once they're off the wire
        socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')

        const received = await text(socket)

        expect([...received.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) => match[1])).toEqual([
          '413',
          '413',
          '200',
        ])
        expect(received).toMatch(/PayloadTooLargeError[\s\S]*PayloadTooLargeError[\s\S]*ok$/)
      })
    })

    it('does not limit the streamed hints', async () => {
      const [octetStream] = createChunkedRequest(
        { 'standard-server': 'octet-stream', 'content-length': '4096' },
        new TextEncoder().encode('x'.repeat(4096)),
      )
      const stream = await toStandardBody(octetStream, { maxBodySize: LIMIT })

      expect(stream).toBeInstanceOf(ReadableStream)
      expect(await new Response(stream as ReadableStream).text()).toBe('x'.repeat(4096))

      const event = `data: "${'x'.repeat(4096)}"\n\n`
      const [eventStream] = createChunkedRequest(
        { 'standard-server': 'event-stream', 'content-length': String(event.length) },
        new TextEncoder().encode(event),
      )
      const iterator = (await toStandardBody(eventStream, { maxBodySize: LIMIT })) as any

      expect(iterator).toSatisfy(isAsyncIteratorObject)
      expect(await iterator.next()).toEqual({ done: false, value: 'x'.repeat(4096) })
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
      body: Uint8Array,
      options?: ToStandardBodyOptions,
    ): Promise<[standardBody: StandardBody, streamedBytes: Uint8Array | undefined]> {
      let standardBody: StandardBody
      let streamedBytes: Uint8Array | undefined
      let error: unknown

      const server = http2.createServer(async (req, res) => {
        try {
          standardBody = await toStandardBody(req, options)

          // a streaming body must be drained while the request is still alive
          if (standardBody instanceof ReadableStream) {
            streamedBytes = new Uint8Array(await new Response(standardBody).arrayBuffer())
          }
        } catch (e) {
          error = e
        }
        res.end()
      })
      onTestFinished(() => new Promise<any>((r) => server.close(r)))

      await new Promise<void>((r) => server.listen(0, r))
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
      const [result] = (await http2Roundtrip(
        onTestFinished,
        { 'content-type': 'multipart/form-data; boundary=X' },
        Buffer.from('--X\r\nContent-Disposition: form-data; name="emoji"\r\n\r\n😀\r\n--X--\r\n'),
      )) as [FormData, undefined]

      expect(result).toBeInstanceOf(FormData)
      expect(result.get('emoji')).toBe('😀')
    })

    it('file', async ({ onTestFinished }) => {
      const body = Buffer.from([0xde, 0xad, 0xbe, 0xef])

      const [result] = (await http2Roundtrip(
        onTestFinished,
        {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="foo.pdf"',
        },
        body,
      )) as [File, undefined]

      expect(result).toBeInstanceOf(File)
      expect(result.name).toBe('foo.pdf')
      expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array(body))
    })

    it('octet-stream', async ({ onTestFinished }) => {
      const body = Buffer.from([0xde, 0xad, 0xbe, 0xef])

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

    describe.each(LIMITED_HINTS)('maxBodySize: %s', (hint) => {
      it('rejects a larger body, yet the response still closes the stream', async ({
        onTestFinished,
      }) => {
        const body = createLimitedBody(hint, 4096)

        // without a content-length, the body is counted as it's read
        for (const headers of [
          limitedHeaders(hint),
          { ...limitedHeaders(hint), 'content-length': String(body.length) },
        ]) {
          await expect(
            http2Roundtrip(onTestFinished, headers, body, { maxBodySize: 1024 }),
          ).rejects.toBeInstanceOf(PayloadTooLargeError)
        }
      })

      it('parses a body up to the limit', async ({ onTestFinished }) => {
        const [result] = await http2Roundtrip(
          onTestFinished,
          limitedHeaders(hint),
          createLimitedBody(hint, 1024),
          { maxBodySize: 1024 },
        )

        await expectLimitedBody(hint, result, 1024)
      })
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

      await expect(toStandardBody(req!)).rejects.toThrow(
        'Failed to read body: body stream already read',
      )
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
      const reader = (standardBody as ReadableStream)
        .pipeThrough(new TextDecoderStream())
        .getReader()
      expect(await reader.read()).toEqual({ done: false, value: 'hello' })
    })

    it('lets the parser reject form-data without content-type', async () => {
      const req = Readable.from([Buffer.from('--X--\r\n')]) as IncomingMessage
      req.headers = { 'standard-server': 'form-data' }

      await expect(toStandardBody(req)).rejects.toThrow(TypeError)
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

  it('file with existing content-type header', async () => {
    const file = new File(['<script>alert(1)</script>'], 'foo.html', { type: 'text/html' })

    generateContentDispositionSpy.mockReturnValue('inline; filename="__mocked__"')

    const [body, headers] = toNodeHttpBody(
      file,
      { ...baseHeaders, 'content-type': 'application/octet-stream' },
      {},
    )

    expect(body).toBeInstanceOf(Readable)
    expect(headers).toEqual({
      'content-disposition': 'inline; filename="__mocked__"',
      'content-length': '25',
      'content-type': 'application/octet-stream',
      'x-custom-header': 'custom-value',
      'standard-server': 'file',
    })

    const response = new Response(body, {
      headers: toFetchHeaders(headers),
    })
    const resBlob = await response.blob()

    expect(resBlob.type).toBe('application/octet-stream')
    expect(await resBlob.text()).toBe('<script>alert(1)</script>')
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

    const reader = Readable.toWeb(body as Readable)
      .pipeThrough(new TextDecoderStream())
      .getReader()

    expect(await reader.read()).toEqual({ done: false, value: ': \n\n' })
    expect(await reader.read()).toEqual({ done: false, value: 'data: 123\n\n' })
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

    const reader = Readable.toWeb(body as Readable)
      .pipeThrough(new TextDecoderStream())
      .getReader()

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

    it('file: unset content-type', async () => {
      const file = new File(['foo'], 'foo.html', { type: 'text/html' })
      const [body, headers] = toNodeHttpBody(file, {
        ...baseHeaders,
        'content-type': [],
      })

      expect(body).toBeInstanceOf(Readable)
      expect(headers).toEqual({
        'content-length': '3',
        'content-type': [],
        'content-disposition': expect.any(String),
        'x-custom-header': 'custom-value',
        'standard-server': 'file',
      })

      const fetchHeaders = toFetchHeaders(headers)
      expect(fetchHeaders.has('content-type')).toBe(false)
    })
  })
})
