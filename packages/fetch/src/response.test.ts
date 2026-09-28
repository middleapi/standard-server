import type { StandardResponse } from '@standard-server/core'
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

  function createPendingIterator() {
    return {
      // like a subscription waiting for its next event
      next: vi.fn(() => new Promise<IteratorResult<unknown>>(() => {})),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }

  describe.each([204, 205, 304])('status %i', (status) => {
    it.each([
      ['null', null],
      ['json', { value: 123 }],
      ['blob', new Blob(['value'])],
      ['form-data', new FormData()],
    ])('drops a %s body', async (_, body) => {
      const fetchResponse = toFetchResponse({
        body,
        headers: { 'x-custom-header': 'custom-value' },
        status,
      })

      expect(fetchResponse.status).toBe(status)
      expect(fetchResponse.body).toBe(null)
      expect(fetchResponse.headers.get('x-custom-header')).toBe('custom-value')
      expect(fetchResponse.headers.get('content-type')).toBe(null)
      expect(fetchResponse.headers.get('content-length')).toBe(null)
      expect(fetchResponse.headers.get('standard-server')).toBe(null)
    })

    it('releases a dropped iterator without starting it', async () => {
      vi.useFakeTimers()

      try {
        const iterator = createPendingIterator()
        const fetchResponse = toFetchResponse({ body: iterator, headers: {}, status })

        await vi.advanceTimersByTimeAsync(100)

        expect(fetchResponse.body).toBe(null)
        expect(iterator.next).not.toHaveBeenCalled()
        expect(iterator.return).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0) // no keep-alive
      }
      finally {
        vi.useRealTimers()
      }
    })

    it('cancels a dropped stream', async () => {
      const cancel = vi.fn()
      const fetchResponse = toFetchResponse({ body: new ReadableStream({ cancel }), headers: {}, status })

      await new Promise(resolve => setTimeout(resolve, 0))

      expect(fetchResponse.body).toBe(null)
      expect(cancel).toHaveBeenCalledTimes(1)
    })

    it('ignores a failure to release a dropped body', async () => {
      const iterator = createPendingIterator()
      iterator.return.mockRejectedValueOnce(new Error('cleanup'))

      expect(toFetchResponse({ body: iterator, headers: {}, status }).status).toBe(status)

      // an unhandled rejection would fail the test run
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(iterator.return).toHaveBeenCalledTimes(1)
    })
  })

  describe.each([
    ['an invalid status', 600, {}, 'status'],
    ['an invalid header', 200, { 'x-custom-header': 'a\nb' }, 'header'],
  ])('when the response cannot be built from %s', (_, status, headers, message) => {
    it('releases an iterator body and stops keep-alive', async () => {
      vi.useFakeTimers()

      try {
        const iterator = createPendingIterator()

        expect(() => toFetchResponse(
          { body: iterator, headers, status },
          { eventStream: { keepAlive: { enabled: true, interval: 10 } } },
        )).toThrow(message)

        await vi.advanceTimersByTimeAsync(100)

        expect(iterator.return).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0) // no keep-alive
      }
      finally {
        vi.useRealTimers()
      }
    })

    it('cancels a stream body with the error', async () => {
      const cancel = vi.fn()

      let error: unknown
      try {
        toFetchResponse({ body: new ReadableStream({ cancel }), headers, status })
      }
      catch (e) {
        error = e
      }

      await new Promise(resolve => setTimeout(resolve, 0))

      expect(error).toBeInstanceOf(Error)
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(cancel).toHaveBeenCalledWith(error)
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
    expect(await lazyResponse2.resolveBody()).toEqual(await toStandardBodySpy.mock.results[0]!.value)
    expect(toStandardBodySpy).toBeCalledTimes(1)
  })
})
