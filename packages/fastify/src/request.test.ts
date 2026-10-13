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

  it('keeps the raw path of absolute-form targets, matching what fastify routed on', async ({
    onTestFinished,
  }) => {
    const seen: { routed: string; url: string }[] = []

    const fastify = Fastify()
    onTestFinished(() => fastify.close())

    // a framework-level path guard in front of a catch-all that hands requests to the adapter
    fastify.all('/rpc/admin/*', async (req, reply) => {
      return reply.code(403).send()
    })

    fastify.all('/rpc/*', async (req, reply) => {
      seen.push({
        routed: `/rpc/${(req.params as any)['*']}`,
        url: toStandardLazyRequest(req, reply).url,
      })
      return reply.code(200).send()
    })

    await fastify.listen({ port: 0, host: '127.0.0.1' })
    const { port } = fastify.server.address() as AddressInfo

    const send = (target: string) =>
      new Promise<string>((resolve, reject) => {
        let response = ''
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.end(`POST ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
        })
        socket.setEncoding('utf8')
        socket.on('data', (chunk) => (response += chunk))
        socket.on('close', () => resolve(response.split('\r\n')[0]!))
        socket.on('error', reject)
      })

    // sanity check: the guard holds for the protected path
    expect(await send('/rpc/admin/deleteUser')).toBe('HTTP/1.1 403 Forbidden')
    expect(await send('http://x/rpc/admin/deleteUser')).toBe('HTTP/1.1 403 Forbidden')
    expect(seen).toEqual([])

    expect(await send('http://x/rpc/public/../admin/deleteUser')).toBe('HTTP/1.1 200 OK')
    expect(await send('http://x/rpc/public/%2e%2e/admin/deleteUser')).toBe('HTTP/1.1 200 OK')
    expect(await send('http://x/rpc/public/%2E%2E/admin/deleteUser')).toBe('HTTP/1.1 200 OK')

    // the adapter reports the raw path, so the inner router can't see a path the guard didn't
    expect(seen.map(({ url }) => url)).toEqual([
      '/rpc/public/../admin/deleteUser',
      '/rpc/public/%2e%2e/admin/deleteUser',
      '/rpc/public/%2E%2E/admin/deleteUser',
    ])
    for (const { routed, url } of seen) {
      expect(decodeURIComponent(url)).toBe(routed)
      expect(url.startsWith('/rpc/admin/')).toBe(false)
    }
  })
})
