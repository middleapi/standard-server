import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { text } from 'node:stream/consumers'

import type { StandardLazyRequest } from '@standard-server/core'
import * as StandardServerNode from '@standard-server/node'
import Fastify from 'fastify'
import request from 'supertest'

import type { ToStandardLazyRequestOptions } from './request'
import { toStandardLazyRequest } from './request'

/**
 * Fastify's default `bodyLimit`
 */
const DEFAULT_BODY_LIMIT = 1024 * 1024

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
    expect(toStandardBodySpy).toBeCalledWith(fastifyReq.raw, {
      hint: undefined,
      maxBodySize: DEFAULT_BODY_LIMIT,
    })
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
    expect(toStandardBodySpy).toBeCalledWith(fastifyReq.raw, {
      hint: 'json',
      maxBodySize: DEFAULT_BODY_LIMIT,
    })
    expect(standardBody).toEqual({ foo: 'bar' })
  })

  describe('body limit', () => {
    const JSON_HEADERS = { 'content-type': 'application/json' }
    const FILE_HEADERS = { 'content-type': 'application/pdf', 'standard-server': 'file' }

    function jsonBody(size: number): Buffer {
      return Buffer.from(JSON.stringify('x'.repeat(size - 2)))
    }

    function fileBody(size: number): Buffer {
      return Buffer.alloc(size, 0x78)
    }

    /**
     * Starts a server with `bodyLimit: 1024` whose routes resolve the body through the adapter.
     */
    async function listen(
      onTestFinished: (fn: () => Promise<any>) => void,
      options: {
        catchAllParser: boolean
        routeBodyLimit?: number
        adapter?: ToStandardLazyRequestOptions
      },
    ): Promise<string> {
      const fastify = Fastify({ bodyLimit: 1024 })
      onTestFinished(() => fastify.close())

      if (options.catchAllParser) {
        fastify.removeAllContentTypeParsers()
        fastify.addContentTypeParser('*', (req, payload, done) => {
          done(null, undefined)
        })
      }

      fastify.all('/*', { bodyLimit: options.routeBodyLimit }, async (req, reply) => {
        await toStandardLazyRequest(req, reply, options.adapter).resolveBody()
        return 'parsed'
      })

      await fastify.listen({ port: 0, host: '127.0.0.1' })
      const { port } = fastify.server.address() as AddressInfo

      return `http://127.0.0.1:${port}`
    }

    /**
     * Sends a body in 256-byte chunks, with a content-length, or chunked encoding if `chunked`.
     */
    function send(
      url: string,
      method: string,
      headers: Record<string, string>,
      body: Buffer,
      chunked = false,
    ): Promise<[status: number, body: string]> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          url,
          {
            method,
            headers: chunked
              ? { ...headers, 'transfer-encoding': 'chunked' }
              : { ...headers, 'content-length': String(body.length) },
          },
          async (res) => resolve([res.statusCode!, await text(res)]),
        )
        req.on('error', reject)

        for (let offset = 0; offset < body.length; offset += 256) {
          req.write(body.subarray(offset, offset + 256))
        }
        req.end()
      })
    }

    describe.each([false, true])('chunked: %s', (chunked) => {
      it('rejects a larger body with 413 behind a catch-all parser', async ({ onTestFinished }) => {
        const url = await listen(onTestFinished, { catchAllParser: true })

        const [fileStatus, fileResponse] = await send(
          url,
          'POST',
          FILE_HEADERS,
          fileBody(4096),
          chunked,
        )
        expect(fileStatus).toBe(413)
        expect(fileResponse).toContain('Body exceeds the size limit of 1024 bytes')

        const [jsonStatus, jsonResponse] = await send(
          url,
          'POST',
          JSON_HEADERS,
          jsonBody(4096),
          chunked,
        )
        expect(jsonStatus).toBe(413)
        expect(jsonResponse).toContain('Body exceeds the size limit of 1024 bytes')

        expect(toStandardBodySpy).toBeCalledTimes(2)
        expect(toStandardBodySpy).toHaveBeenNthCalledWith(1, expect.anything(), {
          hint: undefined,
          maxBodySize: 1024,
        })

        expect(await send(url, 'POST', FILE_HEADERS, fileBody(512), chunked)).toEqual([
          200,
          'parsed',
        ])
        expect(await send(url, 'POST', JSON_HEADERS, jsonBody(512), chunked)).toEqual([
          200,
          'parsed',
        ])
      })

      it('rejects a larger GET body with 413, which fastify leaves unparsed', async ({
        onTestFinished,
      }) => {
        const url = await listen(onTestFinished, { catchAllParser: false })

        const [status, response] = await send(url, 'GET', JSON_HEADERS, jsonBody(4096), chunked)
        expect(status).toBe(413)
        expect(response).toContain('Body exceeds the size limit of 1024 bytes')

        expect(await send(url, 'GET', JSON_HEADERS, jsonBody(512), chunked)).toEqual([
          200,
          'parsed',
        ])
      })

      it('prefers the route bodyLimit, then an explicit maxBodySize', async ({
        onTestFinished,
      }) => {
        const routeUrl = await listen(onTestFinished, {
          catchAllParser: true,
          routeBodyLimit: 8192,
        })
        expect(await send(routeUrl, 'POST', FILE_HEADERS, fileBody(4096), chunked)).toEqual([
          200,
          'parsed',
        ])

        const unlimitedUrl = await listen(onTestFinished, {
          catchAllParser: true,
          adapter: { maxBodySize: Number.POSITIVE_INFINITY },
        })
        expect(await send(unlimitedUrl, 'POST', FILE_HEADERS, fileBody(4096), chunked)).toEqual([
          200,
          'parsed',
        ])

        const explicitUrl = await listen(onTestFinished, {
          catchAllParser: true,
          routeBodyLimit: 8192,
          adapter: { maxBodySize: 256 },
        })
        const [status] = await send(explicitUrl, 'POST', FILE_HEADERS, fileBody(512), chunked)
        expect(status).toBe(413)
      })
    })
  })
})
