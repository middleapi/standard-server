import * as Body from './body'
import * as Headers from './headers'
import { toStandardLazyRequest } from './request'
import * as Url from './url'

const toStandardBodySpy = vi.spyOn(Body, 'toStandardBody')
const toFetchBodySpy = vi.spyOn(Body, 'toFetchBody')
const toStandardHeadersSpy = vi.spyOn(Headers, 'toStandardHeaders')
const toFetchHeadersSpy = vi.spyOn(Headers, 'toFetchHeaders')
const toStandardUrlSpy = vi.spyOn(Url, 'toStandardUrl')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('toStandardLazyRequest', () => {
  it('works', () => {
    const request = new Request('https://example.com', {
      method: 'POST',
      body: JSON.stringify({ foo: 'bar' }),
      headers: {
        'content-type': 'application/json',
      },
    })

    const standardRequest = toStandardLazyRequest(request)

    expect(toStandardUrlSpy).toBeCalledTimes(1)
    expect(toStandardUrlSpy).toBeCalledWith(new URL(request.url))

    expect(standardRequest.url).toEqual(toStandardUrlSpy.mock.results[0]!.value)
    expect(standardRequest.method).toBe('POST')
    expect(standardRequest.signal).toBe(request.signal)
    expect(standardRequest.headers).toEqual(toStandardHeadersSpy.mock.results[0]!.value)
    expect(standardRequest.resolveBody('json')).toBe(toStandardBodySpy.mock.results[0]!.value)

    expect(toStandardHeadersSpy).toBeCalledTimes(1)
    expect(toStandardHeadersSpy).toBeCalledWith(request.headers)

    expect(toStandardBodySpy).toBeCalledTimes(1)
    expect(toStandardBodySpy).toBeCalledWith(request, { hint: 'json' })
  })

  it('headers is lazy and can override', async () => {
    const response = new Request('https://example.com', {
      headers: {
        'x-custom-header': 'custom-value',
      },
    })

    const lazyResponse = toStandardLazyRequest(response)

    expect(toStandardHeadersSpy).toBeCalledTimes(0)
    lazyResponse.headers = { overrided: '1' }
    expect(lazyResponse.headers).toEqual({ overrided: '1' }) // can override before access
    expect(toStandardHeadersSpy).toBeCalledTimes(0)

    const lazyResponse2 = toStandardLazyRequest(response)
    expect(lazyResponse2.headers).toEqual(toStandardHeadersSpy.mock.results[0]!.value)
    expect(lazyResponse2.headers).toEqual(toStandardHeadersSpy.mock.results[0]!.value) // ensure cached
    expect(toStandardHeadersSpy).toBeCalledTimes(1)

    lazyResponse2.headers = { overrided: '2' }
    expect(lazyResponse2.headers).toEqual({ overrided: '2' }) // can override after access
  })
})
