import Stream from 'node:stream'

import * as StandardServerNode from '@standard-server/node'

import * as Body from './body'
import * as Headers from './headers'
import { toStandardLazyRequest } from './request'
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, HttpResponseStream } from './types'
import * as Url from './url'

const toStandardBodySpy = vi.spyOn(Body, 'toStandardBody')
const toStandardHeadersSpy = vi.spyOn(Headers, 'toStandardHeaders')
const toStandardUrlSpy = vi.spyOn(Url, 'toStandardUrl')
const toAbortSignalSpy = vi.spyOn(StandardServerNode, 'toAbortSignal')

beforeEach(() => {
  vi.clearAllMocks()
})

function createResponseStream(): HttpResponseStream {
  const stream = new Stream.Writable({
    write(chunk, encoding, callback) {
      callback()
    },
  }) as HttpResponseStream

  stream.setContentType = vi.fn()

  return stream
}

describe('toStandardLazyRequest', () => {
  const event: APIGatewayProxyEvent = {
    httpMethod: 'POST',
    path: '/example',
    multiValueHeaders: { 'Content-Type': ['application/json'] },
    multiValueQueryStringParameters: { foo: ['bar'] },
    body: '{"foo":"bar"}',
    isBase64Encoded: false,
  }

  it('works', async () => {
    const responseStream = createResponseStream()

    const standardRequest = toStandardLazyRequest(event, responseStream)

    expect(toAbortSignalSpy).toBeCalledTimes(1)
    expect(toAbortSignalSpy).toBeCalledWith(responseStream)
    expect(standardRequest.signal).toBe(toAbortSignalSpy.mock.results[0]!.value)

    expect(toStandardUrlSpy).toBeCalledTimes(1)
    expect(toStandardUrlSpy).toBeCalledWith(event)
    expect(standardRequest.url).toBe('/example?foo=bar')

    expect(standardRequest.method).toBe('POST')

    expect(standardRequest.headers).toEqual({ 'content-type': 'application/json' })
    expect(toStandardHeadersSpy).toBeCalledTimes(1)
    expect(toStandardHeadersSpy).toBeCalledWith(event)

    await expect(standardRequest.resolveBody('json')).resolves.toEqual({ foo: 'bar' })
    expect(toStandardBodySpy).toBeCalledTimes(1)
    expect(toStandardBodySpy).toBeCalledWith(event, { hint: 'json' })
  })

  it('works with a v2 event', async () => {
    const eventV2: APIGatewayProxyEventV2 = {
      rawPath: '/example',
      rawQueryString: 'foo=bar',
      requestContext: { http: { method: 'PUT' } },
      headers: { 'Content-Type': 'application/json' },
      body: '{"foo":"bar"}',
      isBase64Encoded: false,
    }

    const standardRequest = toStandardLazyRequest(eventV2, createResponseStream())

    expect(standardRequest.method).toBe('PUT')
    expect(standardRequest.url).toBe('/example?foo=bar')
    expect(standardRequest.headers).toEqual({ 'content-type': 'application/json' })
    await expect(standardRequest.resolveBody()).resolves.toEqual({ foo: 'bar' })
  })

  it('headers is lazy and can override', () => {
    const lazyRequest = toStandardLazyRequest(event, createResponseStream())

    expect(toStandardHeadersSpy).toBeCalledTimes(0)
    lazyRequest.headers = { overrided: '1' }
    expect(lazyRequest.headers).toEqual({ overrided: '1' }) // can override before access
    expect(toStandardHeadersSpy).toBeCalledTimes(0)

    const lazyRequest2 = toStandardLazyRequest(event, createResponseStream())
    expect(lazyRequest2.headers).toEqual(toStandardHeadersSpy.mock.results[0]!.value)
    expect(lazyRequest2.headers).toEqual(toStandardHeadersSpy.mock.results[0]!.value) // ensure cached
    expect(toStandardHeadersSpy).toBeCalledTimes(1)

    lazyRequest2.headers = { overrided: '2' } // can override after access
    expect(lazyRequest2.headers).toEqual({ overrided: '2' })
  })

  it('signal aborts when the response stream closes early', async () => {
    const responseStream = createResponseStream()

    const standardRequest = toStandardLazyRequest(event, responseStream)

    expect(standardRequest.signal!.aborted).toBe(false)

    responseStream.destroy()

    await vi.waitFor(() => {
      expect(standardRequest.signal!.aborted).toBe(true)
    })
  })
})
