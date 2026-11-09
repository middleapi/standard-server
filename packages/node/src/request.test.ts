import type { IncomingMessage, ServerResponse } from 'node:http'

import type { StandardLazyRequest } from '@standard-server/core'
import request from 'supertest'

import * as Body from './body'
import { toStandardLazyRequest } from './request'
import * as Signal from './signal'

const toStandardBodySpy = vi.spyOn(Body, 'toStandardBody')
const toAbortSignalSpy = vi.spyOn(Signal, 'toAbortSignal')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('toStandardLazyRequest', () => {
  it('works', async () => {
    let standardRequest!: StandardLazyRequest

    await request(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        standardRequest = toStandardLazyRequest(req, res)
        expect(toStandardBodySpy).not.toBeCalled()

        const body = standardRequest.resolveBody('json')
        expect(body).toBe(toStandardBodySpy.mock.results[0]!.value)
        await body // ensure body is load before sending response
        expect(standardRequest.headers).toBe(req.headers)

        expect(toStandardBodySpy).toBeCalledTimes(1)
        expect(toStandardBodySpy).toBeCalledWith(req, { hint: 'json' })
        expect(toAbortSignalSpy).toBeCalledTimes(1)
        expect(toAbortSignalSpy).toBeCalledWith(res)
        res.end()
      } catch (e) {
        console.error(e)
        throw e
      }
    })
      .post('/hello?foo=bar')
      .send({ foo: 'bar' })

    expect(standardRequest.url).toEqual('/hello?foo=bar')
    expect(standardRequest.method).toBe('POST')
    expect(standardRequest.signal?.aborted).toBe(false)
  })
})
