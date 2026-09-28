import { Buffer } from 'node:buffer'
import http2 from 'node:http2'
import { Readable, Writable } from 'node:stream'
import FastifyCookie from '@fastify/cookie'
import * as StandardServerNode from '@standard-server/node'
import Fastify from 'fastify'
import request from 'supertest'
import { sendStandardResponse } from './response'

const toNodeHttpBodySpy = vi.spyOn(StandardServerNode, 'toNodeHttpBody')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sendStandardResponse', () => {
  it('buffered (empty)', async ({ onTestFinished }) => {
    let sendSpy: any

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    const options = { eventStream: { keepAlive: { enabled: true } } }
    fastify.get('/', async (req, reply) => {
      sendSpy = vi.spyOn(reply, 'send')

      await sendStandardResponse(reply, {
        status: 207,
        headers: {
          'x-custom-header': 'custom-value',
        },
        body: undefined,
      }, options)
    })

    await fastify.ready()
    const res = await request(fastify.server).get('/')

    expect(toNodeHttpBodySpy).toBeCalledTimes(1)
    expect(toNodeHttpBodySpy).toBeCalledWith(undefined, {
      'x-custom-header': 'custom-value',
    }, options)

    expect(sendSpy).toBeCalledTimes(1)
    expect(sendSpy).toBeCalledWith(undefined)

    expect(res.status).toBe(207)
    expect(res.headers).not.toHaveProperty('content-type')
    expect(res.headers['x-custom-header']).toEqual('custom-value')

    expect(res.text).toEqual('')
  })

  it('buffered', async ({ onTestFinished }) => {
    let sendSpy: any

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    const options = { eventStream: { keepAlive: { enabled: true } } }
    fastify.get('/', async (req, reply) => {
      sendSpy = vi.spyOn(reply, 'send')

      await sendStandardResponse(reply, {
        status: 207,
        headers: {
          'x-custom-header': 'custom-value',
        },
        body: { foo: 'bar' },
      }, options)
    })

    await fastify.ready()
    const res = await request(fastify.server).get('/')

    expect(toNodeHttpBodySpy).toBeCalledTimes(1)
    expect(toNodeHttpBodySpy).toBeCalledWith({ foo: 'bar' }, {
      'x-custom-header': 'custom-value',
    }, options)

    expect(sendSpy).toBeCalledTimes(1)
    // fastify must NOT serialize the payload again
    expect(sendSpy).toBeCalledWith((await toNodeHttpBodySpy.mock.results[0]!.value)[0])

    expect(res.status).toBe(207)
    expect(res.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'x-custom-header': 'custom-value',
    })

    expect(res.body).toEqual({ foo: 'bar' })
  })

  it('buffered (url search params)', async ({ onTestFinished }) => {
    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    fastify.get('/', async (req, reply) => {
      await sendStandardResponse(reply, {
        status: 207,
        headers: {},
        body: new URLSearchParams({ foo: 'bar' }),
      })
    })

    await fastify.ready()
    const res = await request(fastify.server).get('/')

    expect(res.status).toBe(207)
    expect(res.headers).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded',
    })

    // fastify must NOT serialize the payload again
    expect(res.text).toEqual('foo=bar')
  })

  it('chunked (file)', async ({ onTestFinished }) => {
    const blob = new Blob(['foo'], { type: 'text/plain' })
    let sendSpy: any

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    const options = { eventStream: { keepAlive: { enabled: true } } }
    fastify.get('/', async (req, reply) => {
      sendSpy = vi.spyOn(reply, 'send')

      await sendStandardResponse(reply, {
        status: 207,
        headers: {
          'x-custom-header': 'custom-value',
        },
        body: blob,
      }, options)
    })

    await fastify.ready()
    const res = await request(fastify.server).get('/')

    expect(toNodeHttpBodySpy).toBeCalledTimes(1)
    expect(toNodeHttpBodySpy).toBeCalledWith(blob, {
      'x-custom-header': 'custom-value',
    }, options)

    expect(sendSpy).toBeCalledTimes(1)
    expect(sendSpy).toBeCalledWith((await toNodeHttpBodySpy.mock.results[0]!.value)[0])

    expect(res.status).toBe(207)
    expect(res.headers).toMatchObject({
      'content-disposition': 'inline; filename="blob"; filename*=utf-8\'\'blob',
      'content-length': '3',
      'content-type': 'text/plain',
      'standard-server': 'file',
      'x-custom-header': 'custom-value',
    })

    expect(res.text).toEqual('foo')
  })

  it('chunked (async generator)', async ({ onTestFinished }) => {
    async function* gen() {
      yield 'foo'
      yield 'bar'
      return 'baz'
    }

    const generator = gen()

    let sendSpy: any

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    const options = { eventStream: { keepAlive: { enabled: true } } }
    fastify.get('/', async (req, reply) => {
      sendSpy = vi.spyOn(reply, 'send')

      await sendStandardResponse(reply, {
        status: 207,
        headers: {
          'x-custom-header': 'custom-value',
        },
        body: generator,
      }, options)
    })

    await fastify.ready()
    const res = await request(fastify.server).get('/')

    expect(toNodeHttpBodySpy).toBeCalledTimes(1)
    expect(toNodeHttpBodySpy).toBeCalledWith(generator, {
      'x-custom-header': 'custom-value',
    }, options)

    expect(sendSpy).toBeCalledTimes(1)
    expect(sendSpy).toBeCalledWith((await toNodeHttpBodySpy.mock.results[0]!.value)[0])

    expect(res.status).toBe(207)
    expect(res.headers).toMatchObject({
      'content-type': 'text/event-stream',
      'x-custom-header': 'custom-value',
    })

    expect(res.text).toEqual(': \n\nevent: message\ndata: "foo"\n\nevent: message\ndata: "bar"\n\nevent: close\ndata: "baz"\n\n')
  })

  it('chunked (octet)', async ({ onTestFinished }) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk1'))
        controller.enqueue(new TextEncoder().encode('chunk2'))
        controller.enqueue(new TextEncoder().encode('chunk3'))
        controller.close()
      },
    })

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    fastify.get('/', async (req, reply) => {
      await sendStandardResponse(reply, {
        status: 207,
        headers: {
          'x-custom-header': 'custom-value',
        },
        body: stream,
      })
    })

    await fastify.ready()
    const res = await request(fastify.server).get('/')

    expect(res.status).toBe(207)
    expect(res.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'standard-server': 'octet-stream',
      'x-custom-header': 'custom-value',
    })

    expect(Buffer.from(res.body).toString()).toEqual('chunk1chunk2chunk3')
  })

  it('does not send headers with an undefined value', async ({ onTestFinished }) => {
    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    fastify.get('/', async (req, reply) => {
      await sendStandardResponse(reply, {
        status: 207,
        headers: {
          'x-defined': 'value',
          'x-undefined': undefined,
        },
        body: undefined,
      })
    })

    await fastify.ready()
    const res = await request(fastify.server).get('/')

    expect(res.headers).toHaveProperty('x-defined', 'value')
    // fastify turns `undefined` header values into empty strings
    expect(res.headers).not.toHaveProperty('x-undefined')
  })

  it('sends multi-value headers', async ({ onTestFinished }) => {
    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    fastify.get('/', async (req, reply) => {
      await sendStandardResponse(reply, {
        status: 207,
        headers: {
          'set-cookie': ['foo=bar', 'bar=baz'],
        },
        body: undefined,
      })
    })

    await fastify.ready()
    const res = await request(fastify.server).get('/')

    expect(res.headers['set-cookie']).toEqual(['foo=bar', 'bar=baz'])
  })

  describe('edge case', () => {
    it('error while pulling stream', async ({ onTestFinished }) => {
      const fastify = Fastify()
      onTestFinished(() => fastify.close())

      toNodeHttpBodySpy.mockReturnValueOnce([Readable.fromWeb(new ReadableStream({
        async pull(controller) {
          controller.enqueue(new TextEncoder().encode('foo'))
          await new Promise(r => setTimeout(r, 100))
          controller.error(new Error('foo'))
        },
      })), {}])

      fastify.get('/', async (req, reply) => {
        await sendStandardResponse(reply, {
          status: 207,
          headers: {
            'x-custom-header': 'custom-value',
          },
          async* body() { },
        })
      })

      await fastify.ready()
      await expect(request(fastify.server).get('/')).rejects.toThrow()
    })

    it('request aborted while pulling stream', async ({ onTestFinished }) => {
      const cancelMock = vi.fn()

      const fastify = Fastify()
      onTestFinished(() => fastify.close())

      toNodeHttpBodySpy.mockReturnValueOnce([Readable.fromWeb(new ReadableStream({
        async pull(controller) {
          controller.enqueue(new TextEncoder().encode('foo'))
          await new Promise(r => setTimeout(r, 100))
        },
        cancel: cancelMock,
      })), {}])

      fastify.get('/', async (req, reply) => {
        await sendStandardResponse(reply, {
          status: 207,
          headers: {
            'x-custom-header': 'custom-value',
          },
          async* body() { },
        })
      })

      await fastify.ready()
      const res = request(fastify.server).get('/')

      setTimeout(() => {
        res.abort()
      }, 100)

      await expect(res).rejects.toThrow()

      // fastify destroys the body stream itself when the response closes early
      await vi.waitFor(() => {
        expect(cancelMock).toHaveBeenCalledTimes(1)
      })
    })

    it('rejects and destroys the body when reply throws synchronously', async ({ onTestFinished }) => {
      const cancelMock = vi.fn()

      const fastify = Fastify()
      onTestFinished(() => fastify.close())

      toNodeHttpBodySpy.mockReturnValueOnce([Readable.fromWeb(new ReadableStream({
        async pull(controller) {
          controller.enqueue(new TextEncoder().encode('foo'))
          await new Promise(r => setTimeout(r, 100))
        },
        cancel: cancelMock,
      })), {}])

      let thrownError: any
      fastify.get('/', async (req, reply) => {
        try {
          await sendStandardResponse(reply, {
            // status outside [100, 599] makes reply.status throw FST_ERR_BAD_STATUS_CODE
            status: 999,
            headers: {},
            async* body() { },
          })
        }
        catch (err) {
          thrownError = err
          throw err
        }
      })

      await fastify.ready()
      const res = await request(fastify.server).get('/')

      // fastify's error handler can still send a response
      expect(res.status).toBe(500)
      expect(thrownError.code).toBe('FST_ERR_BAD_STATUS_CODE')

      await vi.waitFor(() => {
        expect(cancelMock).toHaveBeenCalledTimes(1)
      })
    })

    it('works with @fastify/cookie', async ({ onTestFinished }) => {
      const fastify = Fastify()
      onTestFinished(() => fastify.close())

      await fastify.register(FastifyCookie)

      fastify.get('/', async (req, reply) => {
        reply.cookie('foo', 'bar')

        await sendStandardResponse(reply, {
          status: 207,
          headers: {},
          body: { foo: 'bar' },
        })
      })

      await fastify.ready()
      const res = await request(fastify.server).get('/')

      expect(res.status).toBe(207)
      expect(res.headers).toMatchObject({
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': [
          expect.stringContaining('foo=bar'),
        ],
      })

      expect(res.text).toEqual('{"foo":"bar"}')
    })
  })

  describe('response closed before sending', () => {
    it('resolves when the body is not a stream', async () => {
      const raw = new Writable({
        write(chunk, encoding, callback) {
          callback()
        },
      })

      raw.destroy()

      await vi.waitFor(() => {
        expect(raw.closed).toBe(true)
      })

      const reply = {
        raw,
        status: vi.fn(),
        header: vi.fn(),
        send: vi.fn(),
      } as any

      await expect(sendStandardResponse(reply, {
        status: 200,
        headers: {},
        body: { foo: 'bar' },
      })).resolves.toBeUndefined()

      expect(reply.send).not.toHaveBeenCalled()
    })

    it('resolves and destroys the body', async () => {
      let clean = false
      const body = (async function* () {
        try {
          yield 1
        }
        catch {
        }
        finally {
          clean = true
        }
      })()

      const raw = new Writable({
        write(chunk, encoding, callback) {
          callback()
        },
      })

      raw.destroy()

      await vi.waitFor(() => {
        expect(raw.closed).toBe(true)
      })

      const reply = {
        raw,
        status: vi.fn(),
        header: vi.fn(),
        send: vi.fn(),
      } as any

      await expect(sendStandardResponse(reply, {
        status: 200,
        headers: {},
        body,
      })).resolves.toBeUndefined()

      await vi.waitFor(() => {
        expect(clean).toBe(true)
      })

      expect(reply.status).not.toHaveBeenCalled()
      expect(reply.header).not.toHaveBeenCalled()
      expect(reply.send).not.toHaveBeenCalled()
    })

    it('rejects when an http2 response was destroyed with an error', async () => {
      let clean = false
      const body = (async function* () {
        try {
          yield 1
        }
        finally {
          clean = true
        }
      })()

      const stream = new Writable({
        write(chunk, encoding, callback) {
          callback()
        },
      })

      stream.once('error', () => { })
      stream.destroy(new Error('test'))

      await vi.waitFor(() => {
        expect(stream.closed).toBe(true)
      })

      // `Http2ServerResponse` keeps its error on the underlying stream, not on itself
      const reply = {
        raw: { stream },
        status: vi.fn(),
        header: vi.fn(),
        send: vi.fn(),
      } as any

      await expect(sendStandardResponse(reply, {
        status: 200,
        headers: {},
        body,
      })).rejects.toThrow('test')

      await vi.waitFor(() => {
        expect(clean).toBe(true)
      })

      expect(reply.send).not.toHaveBeenCalled()
    })

    it('rejects when response was destroyed with an error', async () => {
      let clean = false
      const body = (async function* () {
        try {
          yield 1
        }
        finally {
          clean = true
        }
      })()

      const raw = new Writable({
        write(chunk, encoding, callback) {
          callback()
        },
      })

      raw.once('error', () => { })
      raw.destroy(new Error('test'))

      await vi.waitFor(() => {
        expect(raw.closed).toBe(true)
      })

      const reply = {
        raw,
        status: vi.fn(),
        header: vi.fn(),
        send: vi.fn(),
      } as any

      await expect(sendStandardResponse(reply, {
        status: 200,
        headers: {},
        body,
      })).rejects.toThrow('test')

      await vi.waitFor(() => {
        expect(clean).toBe(true)
      })

      expect(reply.status).not.toHaveBeenCalled()
      expect(reply.header).not.toHaveBeenCalled()
      expect(reply.send).not.toHaveBeenCalled()
    })
  })

  describe('http2 HEAD request', () => {
    it('sends the status and headers on an auto-exposed HEAD route', async ({ onTestFinished }) => {
      let sending: Promise<void> | undefined

      const fastify = Fastify({ http2: true })
      onTestFinished(() => fastify.close())

      fastify.get('/', async (req, reply) => {
        sending = sendStandardResponse(reply, {
          status: 201,
          headers: { 'x-custom-header': 'custom-value' },
          body: new Blob(['foo']),
        })

        await sending
      })

      const response = await requestHttp2Head(await fastify.listen({ port: 0, host: '127.0.0.1' }))

      await expect(sending).resolves.toBeUndefined()

      expect(response.headers).toMatchObject({
        ':status': 201,
        'content-length': '3',
        'x-custom-header': 'custom-value',
      })
      expect(response.body).toBe('')
    })

    it('resolves and releases a stream body it cannot send on an explicit HEAD route', async ({ onTestFinished }) => {
      let clean = false
      const body = (async function* () {
        try {
          while (true) {
            yield 'foo'
            await new Promise(r => setTimeout(r, 10))
          }
        }
        finally {
          clean = true
        }
      })()

      let sending: Promise<void> | undefined

      const fastify = Fastify({ http2: true })
      onTestFinished(() => fastify.close())

      fastify.head('/', async (req, reply) => {
        sending = sendStandardResponse(reply, {
          status: 201,
          headers: { 'x-custom-header': 'custom-value' },
          body,
        })

        await sending
      })

      const response = await requestHttp2Head(await fastify.listen({ port: 0, host: '127.0.0.1' }))

      await expect(sending).resolves.toBeUndefined()

      expect(response.headers).toMatchObject({
        ':status': 201,
        'content-type': 'text/event-stream',
        'x-custom-header': 'custom-value',
      })
      expect(response.body).toBe('')

      await vi.waitFor(() => {
        expect(clean).toBe(true)
      })
    })
  })
})

async function requestHttp2Head(origin: string): Promise<{ headers: http2.IncomingHttpHeaders, body: string }> {
  const client = http2.connect(origin)

  try {
    const reqStream = client.request({ ':path': '/', ':method': 'HEAD' })

    const chunks: Buffer[] = []
    reqStream.on('data', (chunk: Buffer) => chunks.push(chunk))

    const headers = await new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
      reqStream.once('response', resolve)
      reqStream.once('error', reject)
    })

    await new Promise(r => reqStream.once('close', r))

    return { headers, body: Buffer.concat(chunks).toString() }
  }
  finally {
    client.close()
  }
}
