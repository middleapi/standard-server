import type { StandardLazyRequest } from '@standard-server/core'
import { StandardBodyTooLargeError } from '@standard-server/core'
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

  describe('maxBodySize', () => {
    const body = '{"foo":"bar","baz":"qux"}' // longer than the fastify bodyLimit below

    async function send(
      onTestFinished: (fn: () => Promise<any>) => void,
      options?: (req: any) => StandardServerNode.ToStandardLazyRequestOptions,
    ): Promise<{ status: number, standardBody: unknown, error: unknown }> {
      let standardBody: unknown
      let error: unknown

      const fastify = Fastify({ bodyLimit: 10 })
      onTestFinished(() => fastify.close())

      // the catch-all parser leaves the payload unread, so fastify never applies its bodyLimit
      fastify.addContentTypeParser('*', (req, payload, done) => {
        done(null, undefined)
      })

      fastify.all('/', async (req, reply) => {
        try {
          standardBody = await toStandardLazyRequest(req, reply, options?.(req)).resolveBody()
        }
        catch (e) {
          error = e
          reply.code(413)
        }

        return ''
      })

      await fastify.ready()
      const res = await request(fastify.server)
        .post('/')
        .set('content-type', 'application/x-custom')
        .set('standard-server', 'json')
        .send(body)

      return { status: res.status, standardBody, error }
    }

    it('has no limit by default, even past the fastify bodyLimit', async ({ onTestFinished }) => {
      const { status, standardBody } = await send(onTestFinished)

      expect(status).toBe(200)
      expect(standardBody).toEqual({ foo: 'bar', baz: 'qux' })
    })

    it('parses a body under the limit', async ({ onTestFinished }) => {
      const { status, standardBody } = await send(onTestFinished, () => ({ maxBodySize: body.length }))

      expect(status).toBe(200)
      expect(standardBody).toEqual({ foo: 'bar', baz: 'qux' })
      expect(toStandardBodySpy).toBeCalledWith(expect.anything(), { maxBodySize: body.length, hint: undefined })
    })

    it('rejects a body over the limit, e.g. the route bodyLimit', async ({ onTestFinished }) => {
      const { status, error } = await send(onTestFinished, req => ({ maxBodySize: req.routeOptions.bodyLimit }))

      expect(status).toBe(413)
      expect(error).toBeInstanceOf(StandardBodyTooLargeError)
      expect(toStandardBodySpy).toBeCalledWith(expect.anything(), { maxBodySize: 10, hint: undefined })
    })
  })
})
