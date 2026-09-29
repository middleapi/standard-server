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

  describe('releases the body when the response cannot be built', () => {
    it('event-stream body when the status cannot have a body', async () => {
      const next = vi.fn(() => new Promise<never>(() => {}))
      const cleanup = vi.fn()

      expect(() => toFetchResponse({ status: 204, headers: {}, body: new AsyncIteratorClass(next, cleanup) })).toThrow(TypeError)

      // the event stream starts pulling right away, so it must be cancelled to stop
      // the keep-alive interval and release the pending iterator
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledWith({ kind: 'cancelled' }))
      expect(next).toHaveBeenCalledTimes(1)
    })

    it('stream body when a header is invalid', () => {
      const cancel = vi.fn()

      expect(() => toFetchResponse({ status: 200, headers: { 'x-custom-header': 'a\nb' }, body: new ReadableStream({ cancel }) })).toThrow(TypeError)
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

  it('passes body options to toStandardBody', async () => {
    const response = new Response('data: 1\n\n', {
      headers: {
        'content-type': 'text/event-stream',
      },
    })

    const options = { eventStream: { maxMessageSize: 10 } }
    const lazyResponse = toStandardLazyResponse(response, options)

    await lazyResponse.resolveBody('event-stream')

    expect(toStandardBodySpy).toBeCalledTimes(1)
    expect(toStandardBodySpy).toBeCalledWith(response, { hint: 'event-stream', eventStream: options.eventStream })
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
    expect(await lazyResponse2.resolveBody()).toEqual(await toStandardBodySpy.mock.results[0]!.value)
    expect(toStandardBodySpy).toBeCalledTimes(1)
  })
})
