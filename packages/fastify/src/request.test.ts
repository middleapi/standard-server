import type { AddressInfo } from 'node:net'
import net from 'node:net'

import type { StandardLazyRequest } from '@standard-server/core'
import * as StandardServerNode from '@standard-server/node'
import Fastify from 'fastify'
import request from 'supertest'

import { toStandardLazyRequest } from './request'

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
    expect(toStandardBodySpy).toBeCalledWith(fastifyReq.raw, { hint: undefined })
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
    expect(toStandardBodySpy).toBeCalledWith(fastifyReq.raw, { hint: 'json' })
    expect(standardBody).toEqual({ foo: 'bar' })
  })

  it('aborts every pipelined http1 request when the client disconnects', async ({
    onTestFinished,
  }) => {
    // see `onNodeResponseClose` of @standard-server/node
    const PIPELINED = 20
    const signals: AbortSignal[] = []

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    fastify.get('/', (req, reply) => {
      signals.push(toStandardLazyRequest(req, reply).signal!)
    })

    await fastify.listen({ port: 0, host: '127.0.0.1' })

    const socket = net.connect((fastify.server.address() as AddressInfo).port, '127.0.0.1')
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'.repeat(PIPELINED))

    await vi.waitFor(() => expect(signals).toHaveLength(PIPELINED))
    expect(signals.filter((signal) => signal.aborted)).toHaveLength(0)

    socket.destroy()

    await vi.waitFor(() => {
      expect(signals.filter((signal) => signal.aborted)).toHaveLength(PIPELINED)
    })

    for (const signal of signals) {
      expect(signal.reason).toMatchObject({
        name: 'AbortError',
        message: 'Writable stream closed before it finished writing',
      })
    }
  })
})
