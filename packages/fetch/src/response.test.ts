import type { StandardResponse } from '@standard-server/core'
import { AsyncIteratorClass } from '@standard-server/shared'

import * as Body from './body'
import * as Headers from './headers'
import { toFetchResponse, toStandardLazyResponse } from './response'

const toFetchBodySpy = vi.spyOn(Body, 'toFetchBody')
const toStandardBodySpy = vi.spyOn(Body, 'toStandardBody')
const toFetchHeadersSpy = vi.spyOn(Headers, 'toFetchHeaders')
const toStandardHeadersSpy = vi.spyOn(Headers, 'toStandardHeaders')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('toFetchResponse', () => {
  it('works', async () => {
    const standardResponse: StandardResponse = {
      body: { value: 123 },
      headers: {
        'x-custom-header': 'custom-value',
      },
      status: 206,
    }

    const options = { eventStream: { keepAlive: { enabled: true } } }
    const fetchResponse = toFetchResponse(standardResponse, options)

    expect(fetchResponse.status).toBe(206)
    expect(fetchResponse.headers).toEqual(toFetchHeadersSpy.mock.results[0]!.value)
    expect(await fetchResponse.text()).toEqual(toFetchBodySpy.mock.results[0]!.value[0])

    expect(toFetchBodySpy).toBeCalledTimes(1)
    expect(toFetchBodySpy).toBeCalledWith(standardResponse.body, standardResponse.headers, options)

    expect(toFetchHeadersSpy).toBeCalledTimes(1)
    expect(toFetchHeadersSpy).toBeCalledWith(toFetchBodySpy.mock.results[0]!.value[1])
  })

  describe('exposes the standard-server headers to cross-origin clients', () => {
    it('file body', () => {
      const response = toFetchResponse({
        status: 200,
        headers: {},
        body: new File(['foo'], 'foo.txt', { type: 'text/plain' }),
      })

      expect(response.headers.get('access-control-expose-headers')).toEqual(
        'standard-server, content-disposition',
      )
    })

    it('stream body', () => {
      const response = toFetchResponse({ status: 200, headers: {}, body: new ReadableStream() })

      expect(response.headers.get('access-control-expose-headers')).toEqual('standard-server')

      const withFilename = toFetchResponse({
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="foo.txt"' },
        body: new ReadableStream(),
      })

      expect(withFilename.headers.get('access-control-expose-headers')).toEqual(
        'standard-server, content-disposition',
      )
    })

    it('merges into a value the handler set', () => {
      const response = toFetchResponse({
        status: 200,
        headers: { 'access-control-expose-headers': 'x-custom-header' },
        body: new Blob(['foo']),
      })

      expect(response.headers.get('access-control-expose-headers')).toEqual(
        'x-custom-header, standard-server, content-disposition',
      )
    })

    it('json body adds nothing', () => {
      const response = toFetchResponse({ status: 200, headers: {}, body: { value: 123 } })

      expect(response.headers.has('standard-server')).toBe(false)
      expect(response.headers.has('access-control-expose-headers')).toBe(false)

      const withExposed = toFetchResponse({
        status: 200,
        headers: { 'access-control-expose-headers': 'x-custom-header' },
        body: { value: 123 },
      })

      expect(withExposed.headers.get('access-control-expose-headers')).toEqual('x-custom-header')
    })
  })

  describe('releases the body when the response cannot be built', () => {
    it('event-stream body when the status cannot have a body', async () => {
      const next = vi.fn(() => new Promise<never>(() => {}))
      const cleanup = vi.fn()

      expect(() =>
        toFetchResponse({ status: 204, headers: {}, body: new AsyncIteratorClass(next, cleanup) }),
      ).toThrow(TypeError)

      // the event stream starts pulling right away, so it must be cancelled to stop
      // the keep-alive interval and release the pending iterator
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith({ kind: 'cancelled' }))
      expect(next).toHaveBeenCalledTimes(1)
    })

    it('stream body when a header is invalid', () => {
      const cancel = vi.fn()

      expect(() =>
        toFetchResponse({
          status: 200,
          headers: { 'x-custom-header': 'a\nb' },
          body: new ReadableStream({ cancel }),
        }),
      ).toThrow(TypeError)
      expect(cancel).toHaveBeenCalledWith(expect.any(TypeError))
    })

    it('throws the original error when the stream cannot be cancelled', () => {
      const body = new ReadableStream()
      body.getReader()

      // a locked stream rejects `cancel()`, which must not surface as an unhandled rejection
      expect(() => toFetchResponse({ status: 200, headers: {}, body })).toThrow(/locked/)
    })
  })
})

describe('toStandardLazyResponse', () => {
  it('works', () => {
    const response = new Response(JSON.stringify({ value: 123 }), {
      headers: {
        'x-custom-header': 'custom-value',
        'content-type': 'application/json',
      },
      status: 206,
    })

    const lazyResponse = toStandardLazyResponse(response)

    expect(lazyResponse.status).toBe(206)

    expect(lazyResponse.headers).toBe(toStandardHeadersSpy.mock.results[0]!.value)
    expect(toStandardHeadersSpy).toBeCalledTimes(1)
    expect(toStandardHeadersSpy).toBeCalledWith(response.headers)

    expect(lazyResponse.resolveBody('json')).toBe(toStandardBodySpy.mock.results[0]!.value)
    expect(toStandardBodySpy).toBeCalledTimes(1)
    expect(toStandardBodySpy).toBeCalledWith(response, { hint: 'json' })
  })

  it('headers is lazy and can override', async () => {
    const response = new Response(null, {
      headers: {
        'x-custom-header': 'custom-value',
      },
    })

    const lazyResponse = toStandardLazyResponse(response)

    expect(toStandardHeadersSpy).toBeCalledTimes(0)
    lazyResponse.headers = { overrided: '1' }
    expect(lazyResponse.headers).toEqual({ overrided: '1' }) // can override before access
    expect(toStandardHeadersSpy).toBeCalledTimes(0)

    const lazyResponse2 = toStandardLazyResponse(response)
    expect(lazyResponse2.headers).toEqual(toStandardHeadersSpy.mock.results[0]!.value)
    expect(lazyResponse2.headers).toEqual(toStandardHeadersSpy.mock.results[0]!.value) // ensure cached
    expect(toStandardHeadersSpy).toBeCalledTimes(1)

    lazyResponse2.headers = { overrided: '2' }
    expect(lazyResponse2.headers).toEqual({ overrided: '2' }) // can override after access
  })

  it('lazy body', async () => {
    const blob = new Blob(['value'])
    const response = new Response(blob, {
      headers: {
        'content-type': 'text/plain',
        'Content-Length': blob.size.toString(),
      },
    })

    const lazyResponse = toStandardLazyResponse(response)

    expect(toStandardBodySpy).toBeCalledTimes(0)
    const overrideBody = () => Promise.resolve('1')
    lazyResponse.resolveBody = overrideBody
    expect(lazyResponse.resolveBody).toBe(overrideBody)
    expect(toStandardBodySpy).toBeCalledTimes(0)

    const lazyResponse2 = toStandardLazyResponse(response)
    expect(await lazyResponse2.resolveBody()).toEqual(
      await toStandardBodySpy.mock.results[0]!.value,
    )
    expect(toStandardBodySpy).toBeCalledTimes(1)
  })
})

describe('cross-origin round trip', () => {
  // the browser's CORS response filter: only safelisted and exposed headers stay readable
  const SAFELISTED_HEADERS = [
    'cache-control',
    'content-language',
    'content-length',
    'content-type',
    'expires',
    'last-modified',
    'pragma',
  ]

  function corsFilter(response: Response): Response {
    const exposed = (response.headers.get('access-control-expose-headers') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())

    return new Response(response.body, {
      status: response.status,
      headers: [...response.headers].filter(
        ([key]) => SAFELISTED_HEADERS.includes(key) || exposed.includes(key),
      ),
    })
  }

  it.each([
    ['application/json', '{"isAdmin":true}'],
    ['text/event-stream', 'data: {"injected":1}\n\nevent: error\ndata: {"code":"X"}\n\n'],
    ['multipart/form-data;boundary=x', '--x--\r\n'],
    ['application/x-www-form-urlencoded', 'a=1'],
    ['image/png', 'png'],
  ])('keeps a file typed %s a file', async (type, content) => {
    const response = toFetchResponse({
      status: 200,
      headers: {},
      body: new File([content], 'report.bin', { type }),
    })

    const body = await toStandardLazyResponse(corsFilter(response)).resolveBody()

    expect(body).toBeInstanceOf(File)
    expect((body as File).name).toEqual('report.bin')
    expect((body as File).type).toEqual(type)
    expect(await (body as File).text()).toEqual(content)
  })

  it('keeps a stream labelled application/json a stream', async () => {
    const response = toFetchResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":123}'))
          controller.close()
        },
      }),
    })

    const body = await toStandardLazyResponse(corsFilter(response)).resolveBody()

    expect(body).toBeInstanceOf(ReadableStream)
    expect(await new Response(body as ReadableStream).text()).toEqual('{"value":123}')
  })

  it('falls back to content-header inference when the handler opts out', async () => {
    const response = toFetchResponse({
      status: 200,
      headers: { 'access-control-expose-headers': [] },
      body: new File(['{"isAdmin":true}'], 'report.bin', { type: 'application/json' }),
    })

    expect(await toStandardLazyResponse(corsFilter(response)).resolveBody()).toEqual({
      isAdmin: true,
    })
  })
})
