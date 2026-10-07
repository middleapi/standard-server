import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'

import Fastify, { errorCodes } from 'fastify'

import { sendStandardResponse, standardContentTypeParser, toStandardLazyRequest } from '../src'

/**
 * `@standard-server/node` supports both node http and http2, so the fastify adapter
 * must keep working when fastify is created with `{ http2: true }`.
 */
describe('http2', () => {
  it('round trips a request and a response', async ({ onTestFinished }) => {
    let standardUrl: string | undefined
    let standardMethod: string | undefined
    let standardBody: unknown

    const fastify = Fastify({ http2: true })
    onTestFinished(() => fastify.close())

    fastify.removeAllContentTypeParsers()
    fastify.addContentTypeParser('*', standardContentTypeParser)

    fastify.all('/*', async (req, reply) => {
      const standardRequest = toStandardLazyRequest(req, reply)

      standardUrl = standardRequest.url
      standardMethod = standardRequest.method
      standardBody = await standardRequest.resolveBody()

      await sendStandardResponse(reply, {
        status: 207,
        headers: { 'x-custom-header': 'custom-value' },
        body: { foo: 'bar' },
      })
    })

    await fastify.listen({ port: 0, host: '127.0.0.1' })
    const { port } = fastify.server.address() as AddressInfo

    const client = http2.connect(`http://127.0.0.1:${port}`)
    onTestFinished(() => new Promise<void>((resolve) => client.close(resolve)))

    const stream = client.request({
      ':method': 'POST',
      ':path': '/hello?foo=bar',
      'content-type': 'application/json',
    })

    stream.end('{"hello":"world"}')

    const headers = await new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
      stream.once('response', resolve)
      stream.once('error', reject)
    })

    let text = ''
    stream.setEncoding('utf8')
    for await (const chunk of stream) {
      text += chunk
    }

    expect(standardUrl).toEqual('/hello?foo=bar')
    expect(standardMethod).toEqual('POST')
    expect(standardBody).toEqual({ hello: 'world' })

    expect(headers[':status']).toBe(207)
    expect(headers['x-custom-header']).toBe('custom-value')
    expect(headers['content-type']).toBe('application/json; charset=utf-8')
    expect(text).toEqual('{"foo":"bar"}')
  })

  it('rejects a body over the bodyLimit', async ({ onTestFinished }) => {
    let error: unknown

    const fastify = Fastify({ http2: true, bodyLimit: 100 })
    onTestFinished(() => fastify.close())

    fastify.removeAllContentTypeParsers()
    fastify.addContentTypeParser('*', standardContentTypeParser)

    fastify.all('/*', async (req, reply) => {
      await toStandardLazyRequest(req, reply)
        .resolveBody()
        .catch((e) => {
          error = e
          throw e
        })
    })

    await fastify.listen({ port: 0, host: '127.0.0.1' })
    const { port } = fastify.server.address() as AddressInfo

    const client = http2.connect(`http://127.0.0.1:${port}`)
    onTestFinished(() => new Promise<void>((resolve) => client.close(resolve)))

    const stream = client.request({
      ':method': 'POST',
      ':path': '/',
      'content-type': 'application/json',
    })

    // no content-length, so the limit is only hit while reading
    stream.write(`{"foo":"${'x'.repeat(60)}`)
    stream.end(`${'x'.repeat(60)}"}`)

    const headers = await new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
      stream.once('response', resolve)
      stream.once('error', reject)
    })

    let text = ''
    stream.setEncoding('utf8')
    for await (const chunk of stream) {
      text += chunk
    }

    expect(headers[':status']).toBe(413)
    expect(JSON.parse(text).code).toBe('FST_ERR_CTP_BODY_TOO_LARGE')
    expect(error).toBeInstanceOf(errorCodes.FST_ERR_CTP_BODY_TOO_LARGE)
  })

  it('aborts the request signal when the client cancels', async ({ onTestFinished }) => {
    let signal: AbortSignal | undefined

    const fastify = Fastify({ http2: true })
    onTestFinished(() => fastify.close())

    fastify.all('/*', async (req, reply) => {
      signal = toStandardLazyRequest(req, reply).signal

      await sendStandardResponse(reply, {
        status: 200,
        headers: {},
        body: (async function* () {
          yield 'foo'
          await new Promise((r) => setTimeout(r, 9999999))
        })(),
      })
    })

    await fastify.listen({ port: 0, host: '127.0.0.1' })
    const { port } = fastify.server.address() as AddressInfo

    const client = http2.connect(`http://127.0.0.1:${port}`)
    onTestFinished(() => new Promise<void>((resolve) => client.close(resolve)))

    const stream = client.request({ ':path': '/' })
    stream.once('error', () => {})

    await new Promise<void>((resolve, reject) => {
      stream.once('data', () => resolve())
      stream.once('error', reject)
    })

    expect(signal!.aborted).toBe(false)

    stream.close(http2.constants.NGHTTP2_CANCEL)

    await vi.waitFor(() => {
      expect(signal!.aborted).toBe(true)
    })
  })
})
