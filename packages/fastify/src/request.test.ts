import type { StandardLazyRequest } from '@standard-server/core'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
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

  it('uses the url fastify routed on, not the pre-rewrite `originalUrl`', async ({ onTestFinished }) => {
    let fastifyReq: any
    let standardRequest!: StandardLazyRequest

    const fastify = Fastify({
      rewriteUrl: req => req.url?.replace(/^\/api/, '') || '/',
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
    await request(fastify.server).post('/').set('content-type', 'application/octet-stream').send('{"foo":"bar"}')

    expect(toStandardBodySpy).toBeCalledTimes(1)
    expect(toStandardBodySpy).toBeCalledWith(fastifyReq.raw, { hint: 'json' })
    expect(standardBody).toEqual({ foo: 'bar' })
  })

  describe.each(['/rpc/*', '/*'])('keeps absolute-form request targets raw, standard handler on `%s`', (route) => {
    it('can not skip a guard on `/rpc/admin`', async ({ onTestFinished }) => {
      let adminExecutions = 0

      const fastify = Fastify()
      onTestFinished(() => fastify.close())

      await fastify.register(async (admin) => {
        admin.addHook('onRequest', async (req, reply) => {
          await reply.code(401).send()
        })
        admin.all('/*', async () => {})
      }, { prefix: '/rpc/admin' })

      fastify.all(route, async (req, reply) => {
        // stands for a standard handler routing on the url it is given
        const { url } = toStandardLazyRequest(req, reply)

        if (url.startsWith('/rpc/admin/')) {
          adminExecutions++
          return reply.code(200).send(url)
        }

        return reply.code(404).send(url)
      })

      await fastify.listen({ port: 0, host: '127.0.0.1' })
      const { port } = fastify.server.address() as AddressInfo

      const send = (target: string) => new Promise<{ status: number, body: string }>((resolve, reject) => {
        let response = ''
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
        })
        socket.setEncoding('utf8')
        socket.on('data', chunk => response += chunk)
        socket.on('close', () => resolve({
          status: Number(response.split(' ')[1]),
          body: response.slice(response.indexOf('\r\n\r\n') + 4),
        }))
        socket.on('error', reject)
      })

      expect((await send('/rpc/admin/x')).status).toBe(401)
      expect((await send(`http://127.0.0.1:${port}/rpc/admin/x`)).status).toBe(401)
      expect(await send(`http://127.0.0.1:${port}/rpc/public/x?a=1`)).toEqual({ status: 404, body: '/rpc/public/x?a=1' })

      for (const path of [
        '/rpc/public/../admin/x',
        '/rpc/public/%2e%2e/admin/x',
        '/rpc/public/.%2E/admin/x',
        '/rpc/public/./../admin/x',
        '/rpc/public\\..\\admin/x',
      ]) {
        // the handler gets exactly what an origin-form request for the same path would give it
        expect(await send(`http://127.0.0.1:${port}${path}`)).toEqual({ status: 404, body: path })
        expect(await send(path)).toEqual({ status: 404, body: path })
      }

      // find-my-way hands non-http schemes and paths after `*` to a catch-all route unstripped
      for (const target of ['ws://127.0.0.1/rpc/admin/x', '*/../rpc/admin/x']) {
        expect((await send(target)).status).toBe(404)
      }

      expect(adminExecutions).toBe(0)
    })
  })
})
