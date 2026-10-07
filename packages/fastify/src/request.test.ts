import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { createGunzip, gzipSync } from 'node:zlib'

import type { StandardLazyRequest } from '@standard-server/core'
import * as StandardServerNode from '@standard-server/node'
import type { FastifyInstance, FastifyServerOptions } from 'fastify'
import Fastify, { errorCodes } from 'fastify'
import request from 'supertest'

import { standardContentTypeParser, toStandardLazyRequest } from './request'

const toStandardBodySpy = vi.spyOn(StandardServerNode, 'toStandardBody')
const toStandardMethodSpy = vi.spyOn(StandardServerNode, 'toStandardMethod')
const toStandardUrlSpy = vi.spyOn(StandardServerNode, 'toStandardUrl')
const toAbortSignalSpy = vi.spyOn(StandardServerNode, 'toAbortSignal')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('toStandardLazyRequest', () => {
  it('works & prefer fastify parsed body', async ({ onTestFinished }) => {
    let fastifyReq: any
    let fastifyReply: any
    let standardRequest!: StandardLazyRequest
    let standardBody: any

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    fastify.all('/hello', async (req, reply) => {
      fastifyReq = req
      fastifyReply = reply
      standardRequest = toStandardLazyRequest(req, reply)
      standardBody = await standardRequest.resolveBody()
    })

    await fastify.ready()
    // fastify has its own json body parser
    await request(fastify.server).post('/hello?foo=bar').send({ foo: 'bar' })

    expect(toStandardBodySpy).toBeCalledTimes(0)
    expect(standardBody).toEqual({ foo: 'bar' })

    expect(standardRequest.headers).toBe(fastifyReq.raw.headers)

    expect(toAbortSignalSpy).toBeCalledTimes(1)
    expect(toAbortSignalSpy).toBeCalledWith(fastifyReply.raw)
    expect(standardRequest.signal).toBe(toAbortSignalSpy.mock.results[0]!.value)

    expect(toStandardMethodSpy).toBeCalledTimes(1)
    expect(toStandardMethodSpy).toBeCalledWith(fastifyReq.raw.method)
    expect(standardRequest.method).toBe(toStandardMethodSpy.mock.results[0]!.value)
    expect(standardRequest.method).toBe('POST')

    expect(toStandardUrlSpy).toBeCalledTimes(1)
    expect(toStandardUrlSpy).toBeCalledWith({ url: fastifyReq.raw.url })
    expect(standardRequest.url).toBe(toStandardUrlSpy.mock.results[0]!.value)
    expect(standardRequest.url).toBe('/hello?foo=bar')
  })

  it('uses the url fastify routed on, not the pre-rewrite `originalUrl`', async ({
    onTestFinished,
  }) => {
    let fastifyReq: any
    let standardRequest!: StandardLazyRequest

    const fastify = Fastify({
      rewriteUrl: (req) => req.url?.replace(/^\/api/, '') || '/',
    })
    onTestFinished(() => fastify.close())

    fastify.all('/hello', async (req, reply) => {
      fastifyReq = req
      standardRequest = toStandardLazyRequest(req, reply)
    })

    await fastify.ready()
    await request(fastify.server).get('/api/hello?foo=bar')

    expect(fastifyReq.raw.originalUrl).toBe('/api/hello?foo=bar')
    expect(fastifyReq.raw.url).toBe('/hello?foo=bar')

    expect(toStandardUrlSpy).toBeCalledTimes(1)
    expect(toStandardUrlSpy).toBeCalledWith({ url: '/hello?foo=bar' })
    expect(standardRequest.url).toBe(toStandardUrlSpy.mock.results[0]!.value)
    expect(standardRequest.url).toBe('/hello?foo=bar')
  })

  it('fallback to standard body parser', async ({ onTestFinished }) => {
    let fastifyReq: any
    let standardRequest!: StandardLazyRequest
    let standardBody: any

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    // allow any content type, and leave the body unparsed
    fastify.addContentTypeParser('*', (req, payload, done) => {
      done(null, undefined)
    })

    fastify.all('/', async (req, reply) => {
      fastifyReq = req
      standardRequest = toStandardLazyRequest(req, reply)
      standardBody = await standardRequest.resolveBody()
    })

    await fastify.ready()
    await request(fastify.server).post('/').field('foo', 'bar')

    const expectedBody = new FormData()
    expectedBody.append('foo', 'bar')

    expect(toStandardBodySpy).toBeCalledTimes(1)
    expect(toStandardBodySpy).toBeCalledWith(expect.any(Readable), { hint: undefined })
    expect(toStandardBodySpy.mock.calls[0]![0].headers).toBe(fastifyReq.headers)
    expect(standardBody).toEqual(expectedBody)
  })

  it('forwards the body hint to the standard body parser', async ({ onTestFinished }) => {
    let fastifyReq: any
    let standardBody: any

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    // allow any content type, and leave the body unparsed
    fastify.addContentTypeParser('*', (req, payload, done) => {
      done(null, undefined)
    })

    fastify.all('/', async (req, reply) => {
      fastifyReq = req
      standardBody = await toStandardLazyRequest(req, reply).resolveBody('json')
    })

    await fastify.ready()
    // fastify has no built-in parser for this content type, so the body stays unparsed
    await request(fastify.server)
      .post('/')
      .set('content-type', 'application/octet-stream')
      .send('{"foo":"bar"}')

    expect(toStandardBodySpy).toBeCalledTimes(1)
    expect(toStandardBodySpy).toBeCalledWith(expect.any(Readable), { hint: 'json' })
    expect(toStandardBodySpy.mock.calls[0]![0].headers).toBe(fastifyReq.headers)
    expect(standardBody).toEqual({ foo: 'bar' })
  })
})

describe('standardContentTypeParser', () => {
  it('resolves the body a preParsing hook transformed', async ({ onTestFinished }) => {
    let standardBody: unknown

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    fastify.removeAllContentTypeParsers()
    fastify.addContentTypeParser('*', standardContentTypeParser)

    // how decompression plugins hook into fastify
    fastify.addHook('preParsing', async (req, reply, payload) =>
      req.headers['content-encoding'] === 'gzip' ? payload.pipe(createGunzip()) : payload,
    )

    fastify.post('/', async (req, reply) => {
      standardBody = await toStandardLazyRequest(req, reply).resolveBody()
      return 'ok'
    })

    const clientReq = await openRequest(fastify, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    })
    clientReq.end(gzipSync('{"hello":"world"}'))

    const res = await readResponse(clientReq)

    expect(res.status).toBe(200)
    expect(standardBody).toEqual({ hello: 'world' })
  })

  it('streams an octet-stream body as it arrives', async ({ onTestFinished }) => {
    const chunks: string[] = []

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    fastify.removeAllContentTypeParsers()
    fastify.addContentTypeParser('*', standardContentTypeParser)

    fastify.post('/', async (req, reply) => {
      const body = await toStandardLazyRequest(req, reply).resolveBody()

      expect(body).toBeInstanceOf(ReadableStream)

      for await (const chunk of body as ReadableStream<Uint8Array>) {
        chunks.push(new TextDecoder().decode(chunk))
      }

      return chunks
    })

    const clientReq = await openRequest(fastify, { 'content-type': 'application/octet-stream' })

    clientReq.write('chunk1')
    // the server reads the first chunk while the request is still open
    await vi.waitFor(() => expect(chunks).toEqual(['chunk1']))
    clientReq.end('chunk2')

    const res = await readResponse(clientReq)

    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toEqual(['chunk1', 'chunk2'])
  })

  it('refuses to read the body twice', async ({ onTestFinished }) => {
    let secondRead: Promise<unknown> | undefined

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    fastify.removeAllContentTypeParsers()
    fastify.addContentTypeParser('*', standardContentTypeParser)

    fastify.post('/', async (req, reply) => {
      const standardRequest = toStandardLazyRequest(req, reply)
      const body = await standardRequest.resolveBody()
      secondRead = standardRequest.resolveBody()
      secondRead.catch(() => {})
      return body
    })

    await fastify.ready()
    const res = await request(fastify.server)
      .post('/')
      .set('content-type', 'application/json')
      .send('{"foo":"bar"}')

    expect(res.body).toEqual({ foo: 'bar' })
    await expect(secondRead).rejects.toThrow('Failed to read body: body stream already read')
  })
})

describe.each([
  ['standardContentTypeParser', standardContentTypeParser],
  [
    'a parser that leaves the body unparsed',
    (req: unknown, payload: unknown, done: (error: null, body: undefined) => void) =>
      done(null, undefined),
  ],
] as const)('bodyLimit with %s', (_, parser) => {
  function createFastify(options: FastifyServerOptions = {}): FastifyInstance {
    const fastify = Fastify(options)

    fastify.removeAllContentTypeParsers()
    fastify.addContentTypeParser('*', parser)

    return fastify
  }

  it('resolves a body within the limit', async ({ onTestFinished }) => {
    let standardBody: unknown

    const fastify = createFastify({ bodyLimit: 100 })
    onTestFinished(() => fastify.close())

    fastify.post('/', async (req, reply) => {
      standardBody = await toStandardLazyRequest(req, reply).resolveBody()
      return 'ok'
    })

    await fastify.ready()
    const body = { foo: 'x'.repeat(80) }
    const res = await request(fastify.server).post('/').send(body)

    expect(res.status).toBe(200)
    expect(standardBody).toEqual(body)
  })

  it('rejects a body declared over the limit', async ({ onTestFinished }) => {
    let error: unknown

    const fastify = createFastify({ bodyLimit: 100 })
    onTestFinished(() => fastify.close())

    fastify.post('/', async (req, reply) => {
      await toStandardLazyRequest(req, reply)
        .resolveBody()
        .catch((e) => {
          error = e
          throw e
        })
    })

    await fastify.ready()
    const res = await request(fastify.server)
      .post('/')
      .send({ foo: 'x'.repeat(10_000) })

    expect(res.status).toBe(413)
    expect(res.body.code).toBe('FST_ERR_CTP_BODY_TOO_LARGE')
    expect(res.headers.connection).toBe('close')
    expect(error).toBeInstanceOf(errorCodes.FST_ERR_CTP_BODY_TOO_LARGE)
  })

  it('rejects a body of unknown length once it grows over the limit', async ({
    onTestFinished,
  }) => {
    const fastify = createFastify({ bodyLimit: 100 })
    onTestFinished(() => fastify.close())

    fastify.post('/', async (req, reply) => {
      await toStandardLazyRequest(req, reply).resolveBody()
    })

    const clientReq = await openRequest(fastify, { 'content-type': 'application/json' })

    expect(clientReq.getHeader('content-length')).toBeUndefined()
    clientReq.write(`{"foo":"${'x'.repeat(60)}`)
    clientReq.end(`${'x'.repeat(60)}"}`)

    const res = await readResponse(clientReq)

    expect(res.status).toBe(413)
    expect(JSON.parse(res.text).code).toBe('FST_ERR_CTP_BODY_TOO_LARGE')
  })

  it('fails a streaming body once it grows over the limit', async ({ onTestFinished }) => {
    const chunks: string[] = []
    let error: unknown

    const fastify = createFastify({ bodyLimit: 10 })
    onTestFinished(() => fastify.close())

    fastify.post('/', async (req, reply) => {
      const body = await toStandardLazyRequest(req, reply).resolveBody()

      try {
        for await (const chunk of body as ReadableStream<Uint8Array>) {
          chunks.push(new TextDecoder().decode(chunk))
        }
      } catch (e) {
        error = e
        throw e
      }
    })

    const clientReq = await openRequest(fastify, { 'content-type': 'application/octet-stream' })

    clientReq.write('chunk1')
    await vi.waitFor(() => expect(chunks).toEqual(['chunk1']))
    clientReq.end('chunk2')

    const res = await readResponse(clientReq)

    expect(res.status).toBe(413)
    expect(error).toBeInstanceOf(errorCodes.FST_ERR_CTP_BODY_TOO_LARGE)
  })

  it('uses the route bodyLimit over the instance one', async ({ onTestFinished }) => {
    let standardBody: unknown

    const fastify = createFastify({ bodyLimit: 100 })
    onTestFinished(() => fastify.close())

    fastify.post('/large', { bodyLimit: 20_000 }, async (req, reply) => {
      standardBody = await toStandardLazyRequest(req, reply).resolveBody()
      return 'ok'
    })

    fastify.post('/small', { bodyLimit: 10 }, async (req, reply) => {
      await toStandardLazyRequest(req, reply).resolveBody()
    })

    await fastify.ready()
    const body = { foo: 'x'.repeat(10_000) }

    const large = await request(fastify.server).post('/large').send(body)
    expect(large.status).toBe(200)
    expect(standardBody).toEqual(body)

    const small = await request(fastify.server).post('/small').send({ foo: 'bar' })
    expect(small.status).toBe(413)
  })
})

it('bodyLimit applies to the body a preParsing hook decoded', async ({ onTestFinished }) => {
  const fastify = Fastify({ bodyLimit: 100 })
  onTestFinished(() => fastify.close())

  fastify.removeAllContentTypeParsers()
  fastify.addContentTypeParser('*', standardContentTypeParser)

  fastify.addHook('preParsing', async (req, reply, payload) =>
    req.headers['content-encoding'] === 'gzip' ? payload.pipe(createGunzip()) : payload,
  )

  fastify.post('/', async (req, reply) => {
    await toStandardLazyRequest(req, reply).resolveBody()
  })

  const compressed = gzipSync(JSON.stringify({ foo: 'x'.repeat(10_000) }))

  expect(compressed.byteLength).toBeLessThan(100)

  const clientReq = await openRequest(fastify, {
    'content-type': 'application/json',
    'content-encoding': 'gzip',
  })
  clientReq.end(compressed)

  const res = await readResponse(clientReq)

  expect(res.status).toBe(413)
  expect(JSON.parse(res.text).code).toBe('FST_ERR_CTP_BODY_TOO_LARGE')
})

/**
 * Open a request whose body is written by the test, so it is sent chunked and can be paced.
 */
async function openRequest(
  fastify: FastifyInstance,
  headers: http.OutgoingHttpHeaders,
): Promise<http.ClientRequest> {
  await fastify.listen({ port: 0, host: '127.0.0.1' })
  const { port } = fastify.server.address() as AddressInfo

  const clientReq = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers })
  // don't keep fastify from closing when the test fails before the request ends
  onTestFinished(() => {
    clientReq.destroy()
  })

  return clientReq
}

async function readResponse(
  clientReq: http.ClientRequest,
): Promise<{ status: number | undefined; text: string }> {
  const [res] = (await once(clientReq, 'response')) as [http.IncomingMessage]

  return { status: res.statusCode, text: await text(res) }
}
