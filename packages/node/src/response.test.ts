import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import Stream from 'node:stream'

import type { StandardResponse } from '@standard-server/core'
import request from 'supertest'

import * as Body from './body'
import { sendStandardResponse } from './response'

const toNodeHttpBodySpy = vi.spyOn(Body, 'toNodeHttpBody')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sendStandardResponse', () => {
  it('buffered (empty)', async () => {
    let endSpy: any

    const options = { eventStream: { keepAlive: { enabled: true } } }
    const res = await request(async (req: IncomingMessage, res: ServerResponse) => {
      endSpy = vi.spyOn(res, 'end')

      await sendStandardResponse(
        res,
        {
          status: 207,
          headers: {
            'x-custom-header': 'custom-value',
          },
          body: undefined,
        },
        options,
      )
    }).get('/')

    expect(toNodeHttpBodySpy).toBeCalledTimes(1)
    expect(toNodeHttpBodySpy).toBeCalledWith(
      undefined,
      {
        'x-custom-header': 'custom-value',
      },
      options,
    )

    expect(endSpy).toBeCalledTimes(1)
    expect(endSpy).toBeCalledWith()

    expect(res.status).toBe(207)
    expect(res.headers).not.toHaveProperty('content-type')
    expect(res.headers['x-custom-header']).toEqual('custom-value')

    expect(res.text).toEqual('')
  })

  it('buffered', async () => {
    let endSpy: any

    const options = { eventStream: { keepAlive: { enabled: true } } }
    const res = await request(async (req: IncomingMessage, res: ServerResponse) => {
      endSpy = vi.spyOn(res, 'end')

      await sendStandardResponse(
        res,
        {
          status: 207,
          headers: {
            'x-custom-header': 'custom-value',
          },
          body: { foo: 'bar' },
        },
        options,
      )
    }).get('/')

    expect(toNodeHttpBodySpy).toBeCalledTimes(1)
    expect(toNodeHttpBodySpy).toBeCalledWith(
      { foo: 'bar' },
      {
        'x-custom-header': 'custom-value',
      },
      options,
    )

    expect(endSpy).toBeCalledTimes(1)
    expect(endSpy).toBeCalledWith((await toNodeHttpBodySpy.mock.results[0]!.value)[0])

    expect(res.status).toBe(207)
    expect(res.headers).toMatchObject({
      'content-type': 'application/json',
      'x-custom-header': 'custom-value',
    })

    expect(res.body).toEqual({ foo: 'bar' })
  })

  it('chunked (file)', async () => {
    const blob = new Blob(['foo'], { type: 'text/plain' })
    let endSpy: any

    const options = { eventStream: { keepAlive: { enabled: true } } }
    const res = await request(async (req: IncomingMessage, res: ServerResponse) => {
      endSpy = vi.spyOn(res, 'end')

      await sendStandardResponse(
        res,
        {
          status: 207,
          headers: {
            'x-custom-header': 'custom-value',
          },
          body: blob,
        },
        options,
      )
    }).get('/')

    expect(toNodeHttpBodySpy).toBeCalledTimes(1)
    expect(toNodeHttpBodySpy).toBeCalledWith(
      blob,
      {
        'x-custom-header': 'custom-value',
      },
      options,
    )

    expect(endSpy).toBeCalledTimes(1)
    expect(endSpy).toBeCalledWith()

    expect(res.status).toBe(207)
    expect(res.headers).toMatchObject({
      'content-disposition': 'inline; filename="blob"; filename*=utf-8\'\'blob',
      'content-length': '3',
      'content-type': 'text/plain',
      'x-custom-header': 'custom-value',
    })

    expect(res.text).toEqual('foo')
  })

  it('chunked (async generator)', async () => {
    async function* gen() {
      yield 'foo'
      yield 'bar'
      return 'baz'
    }

    const generator = gen()

    let endSpy: any

    const options = { eventStream: { keepAlive: { enabled: true } } }

    const res = await request(async (req: IncomingMessage, res: ServerResponse) => {
      endSpy = vi.spyOn(res, 'end')

      await sendStandardResponse(
        res,
        {
          status: 207,
          headers: {
            'x-custom-header': 'custom-value',
          },
          body: generator,
        },
        options,
      )
    }).get('/')

    expect(toNodeHttpBodySpy).toBeCalledTimes(1)
    expect(toNodeHttpBodySpy).toBeCalledWith(
      generator,
      {
        'x-custom-header': 'custom-value',
      },
      options,
    )

    expect(endSpy).toBeCalledTimes(1)
    expect(endSpy).toBeCalledWith()

    expect(res.status).toBe(207)
    expect(res.headers).toMatchObject({
      'content-type': 'text/event-stream',
      'x-custom-header': 'custom-value',
    })

    expect(res.text).toEqual(': \n\ndata: "foo"\n\ndata: "bar"\n\nevent: close\ndata: "baz"\n\n')
  })

  it('chunked (octet)', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk1'))
        controller.enqueue(new TextEncoder().encode('chunk2'))
        controller.enqueue(new TextEncoder().encode('chunk3'))
        controller.close()
      },
    })

    let endSpy: any

    const options = { eventStream: { keepAlive: { enabled: true } } }

    const res = await request(async (req: IncomingMessage, res: ServerResponse) => {
      endSpy = vi.spyOn(res, 'end')

      await sendStandardResponse(
        res,
        {
          status: 207,
          headers: {
            'x-custom-header': 'custom-value',
          },
          body: stream,
        },
        options,
      )
    }).get('/')

    expect(toNodeHttpBodySpy).toBeCalledTimes(1)
    expect(toNodeHttpBodySpy).toBeCalledWith(
      stream,
      {
        'x-custom-header': 'custom-value',
      },
      options,
    )

    expect(endSpy).toBeCalledTimes(1)
    expect(endSpy).toBeCalledWith()

    expect(res.status).toBe(207)
    expect(res.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'x-custom-header': 'custom-value',
    })

    expect(Buffer.from(res.body).toString()).toEqual('chunk1chunk2chunk3')
  })

  it('should destroy response when stream encounters an error during streaming', async () => {
    const error = new Error('TEST')
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk1'))
        controller.enqueue(new TextEncoder().encode('chunk2'))
        controller.error(error)
      },
    })

    let destroySpy: any
    let thrownError: any

    const options = {}
    await expect(
      request(async (req: IncomingMessage, res: ServerResponse) => {
        destroySpy = vi.spyOn(res, 'destroy')

        try {
          await sendStandardResponse(
            res,
            {
              status: 207,
              headers: {
                'x-custom-header': 'custom-value',
              },
              body: stream,
            },
            options,
          )
        } catch (err) {
          thrownError = err
        }
      }).get('/'),
    ).rejects.toThrow()

    expect(toNodeHttpBodySpy).toBeCalledTimes(1)
    expect(toNodeHttpBodySpy).toBeCalledWith(
      stream,
      {
        'x-custom-header': 'custom-value',
      },
      options,
    )

    expect(destroySpy).toBeCalledTimes(1)
    expect(destroySpy).toBeCalledWith(error)
    expect(thrownError).toBe(undefined)
  })

  it('rejects, destroys the response and the body when applying headers throws', async () => {
    let destroySpy: any
    let thrownError: any

    const options = {}
    await expect(
      request(async (req: IncomingMessage, res: ServerResponse) => {
        destroySpy = vi.spyOn(res, 'destroy')

        try {
          await sendStandardResponse(
            res,
            {
              status: 207,
              headers: {
                'x-invalid': 'bad\nvalue',
              },
              body: (async function* () {
                yield 1
              })(),
            },
            options,
          )
        } catch (err) {
          thrownError = err
        }
      }).get('/'),
    ).rejects.toThrow()

    expect(thrownError).toBeInstanceOf(Error)
    expect(thrownError.code).toBe('ERR_INVALID_CHAR')

    expect(destroySpy).toHaveBeenCalledWith(thrownError)

    const [resBody] = toNodeHttpBodySpy.mock.results[0]!.value
    expect((resBody as any).destroyed).toBe(true)
  })

  it('resolves without sending when headers were already flushed', async () => {
    let sendError: any

    const res = await request(async (req: IncomingMessage, res: ServerResponse) => {
      res.flushHeaders()

      try {
        await sendStandardResponse(res, {
          status: 207,
          headers: {
            'x-custom-header': 'custom-value',
          },
          body: undefined,
        })
      } catch (err) {
        sendError = err
      }

      res.end('flushed')
    }).get('/')

    expect(sendError).toBeUndefined()

    expect(res.status).toBe(200)
    expect(res.headers).not.toHaveProperty('x-custom-header')
    expect(res.text).toEqual('flushed')
  })

  describe('stream destroy while sending', () => {
    it('with error', async () => {
      let clean = false
      const res: StandardResponse = {
        body: (async function* () {
          try {
            yield 1
            await new Promise((r) => setTimeout(r, 100))
            yield 2
            await new Promise((r) => setTimeout(r, 100))
            yield 3
            await new Promise((r) => setTimeout(r, 9999999))
            yield 4
          } finally {
            clean = true
          }
        })(),
        headers: {
          'x-custom-header': 'custom-value',
          'set-cookie': ['foo=bar', 'bar=baz'],
        },
        status: 206,
      }

      const chunks: any[] = []
      const responseStream = new Stream.Writable({
        write(chunk, encoding, callback) {
          chunks.push(chunk)
          callback()
        },
      })

      ;(responseStream as any).setHeader = vi.fn()

      const sendPromise = expect(sendStandardResponse(responseStream as any, res)).rejects.toThrow(
        'test',
      )

      await new Promise((r) => setTimeout(r, 120))

      expect(chunks).toEqual([
        Buffer.from(': \n\n'),
        Buffer.from('data: 1\n\n'),
        Buffer.from('data: 2\n\n'),
      ])

      expect(responseStream.closed).toBe(false)
      expect(clean).toBe(false)

      responseStream.destroy(new Error('test'))

      await vi.waitFor(() => {
        expect(responseStream.closed).toBe(true)
        expect(clean).toBe(true)
      })

      await sendPromise
    })

    it('without error', async () => {
      let clean = false
      const res: StandardResponse = {
        body: (async function* () {
          try {
            yield 1
            await new Promise((r) => setTimeout(r, 100))
            yield 2
            await new Promise((r) => setTimeout(r, 100))
            yield 3
            await new Promise((r) => setTimeout(r, 9999999))
            yield 4
          } finally {
            clean = true
          }
        })(),
        headers: {
          'x-custom-header': 'custom-value',
          'set-cookie': ['foo=bar', 'bar=baz'],
        },
        status: 206,
      }

      const chunks: any[] = []
      const responseStream = new Stream.Writable({
        write(chunk, encoding, callback) {
          chunks.push(chunk)
          callback()
        },
      })

      ;(responseStream as any).setHeader = vi.fn()

      const sendPromise = sendStandardResponse(responseStream as any, res)

      await new Promise((r) => setTimeout(r, 110))

      expect(chunks).toEqual([
        Buffer.from(': \n\n'),
        Buffer.from('data: 1\n\n'),
        Buffer.from('data: 2\n\n'),
      ])

      expect(responseStream.closed).toBe(false)
      expect(clean).toBe(false)

      responseStream.destroy()

      await vi.waitFor(() => {
        expect(responseStream.closed).toBe(true)
        expect(clean).toBe(true)
      })

      await sendPromise
    })
  })

  describe('response closed before sending', () => {
    it('resolves and destroys the body', async () => {
      let clean = false
      const res: StandardResponse = {
        body: (async function* () {
          try {
            yield 1
          } catch (error) {
          } finally {
            clean = true
          }
        })(),
        headers: {},
        status: 200,
      }

      const responseStream = new Stream.Writable({
        write(chunk, encoding, callback) {
          callback()
        },
      })

      ;(responseStream as any).setHeader = vi.fn()

      responseStream.destroy()

      await vi.waitFor(() => {
        expect(responseStream.closed).toBe(true)
      })

      await expect(sendStandardResponse(responseStream as any, res)).resolves.toBeUndefined()

      await vi.waitFor(() => {
        expect(clean).toBe(true)
      })

      expect((responseStream as any).setHeader).not.toHaveBeenCalled()
    })

    it('rejects when response was destroyed with an error', async () => {
      let clean = false
      const res: StandardResponse = {
        body: (async function* () {
          try {
            yield 1
          } finally {
            clean = true
          }
        })(),
        headers: {},
        status: 200,
      }

      const responseStream = new Stream.Writable({
        write(chunk, encoding, callback) {
          callback()
        },
      })

      ;(responseStream as any).setHeader = vi.fn()

      responseStream.once('error', () => {})
      responseStream.destroy(new Error('test'))

      await vi.waitFor(() => {
        expect(responseStream.closed).toBe(true)
      })

      await expect(sendStandardResponse(responseStream as any, res)).rejects.toThrow('test')

      await vi.waitFor(() => {
        expect(clean).toBe(true)
      })

      expect((responseStream as any).setHeader).not.toHaveBeenCalled()
    })
  })

  describe('http2 HEAD request', () => {
    it('sends the status and headers', async () => {
      let sending: Promise<void> | undefined

      const response = await requestHttp2Head((_, res) => {
        sending = sendStandardResponse(res, {
          status: 201,
          headers: { 'x-custom-header': 'custom-value' },
          body: undefined,
        })
      })

      await expect(sending).resolves.toBeUndefined()

      expect(response.headers).toMatchObject({
        ':status': 201,
        'x-custom-header': 'custom-value',
      })
      expect(response.body).toBe('')
    })

    it('rejects and releases a stream body it cannot send', async () => {
      let clean = false
      const body = (async function* () {
        try {
          while (true) {
            yield 'foo'
            await new Promise((r) => setTimeout(r, 10))
          }
        } finally {
          clean = true
        }
      })()

      let sending: Promise<void> | undefined

      const response = await requestHttp2Head((_, res) => {
        sending = sendStandardResponse(res, { status: 201, headers: {}, body })
        sending.catch(() => {})
      })

      await expect(sending).rejects.toMatchObject({ code: 'ERR_STREAM_WRITE_AFTER_END' })

      expect(response.headers).toMatchObject({
        ':status': 201,
        'content-type': 'text/event-stream',
      })
      expect(response.body).toBe('')

      await vi.waitFor(() => {
        expect(clean).toBe(true)
      })
    })
  })

  describe('http2 stream reset by the client', () => {
    it.each([
      ['resolves on a cancel', http2.constants.NGHTTP2_CANCEL, undefined],
      [
        'rejects with the stream error on an error code',
        http2.constants.NGHTTP2_INTERNAL_ERROR,
        'ERR_HTTP2_STREAM_ERROR',
      ],
    ])('%s', async (_, code, errorCode) => {
      let clean = false
      const body = (async function* () {
        try {
          while (true) {
            yield 'foo'
            await new Promise((r) => setTimeout(r, 10))
          }
        } finally {
          clean = true
        }
      })()

      let sending: Promise<void> | undefined

      const server = http2.createServer((req, res) => {
        sending = sendStandardResponse(res, { status: 200, headers: {}, body })
      })
      await new Promise<void>((r) => server.listen(0, r))

      const client = http2.connect(`http://localhost:${(server.address() as AddressInfo).port}`)

      try {
        const reqStream = client.request({ ':path': '/' })
        reqStream.once('error', () => {})

        await new Promise((r) => reqStream.once('data', r))
        reqStream.close(code)

        if (errorCode) {
          await expect(sending).rejects.toMatchObject({ code: errorCode })
        } else {
          await expect(sending).resolves.toBeUndefined()
        }

        await vi.waitFor(() => {
          expect(clean).toBe(true)
        })
      } finally {
        client.close()
        await new Promise((r) => server.close(r))
      }
    })
  })
})

async function requestHttp2Head(
  listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
): Promise<{ headers: http2.IncomingHttpHeaders; body: string }> {
  const server = http2.createServer(listener)
  await new Promise<void>((r) => server.listen(0, r))

  const client = http2.connect(`http://localhost:${(server.address() as AddressInfo).port}`)

  try {
    const reqStream = client.request({ ':path': '/', ':method': 'HEAD' })

    const chunks: Buffer[] = []
    reqStream.on('data', (chunk: Buffer) => chunks.push(chunk))

    const headers = await new Promise<http2.IncomingHttpHeaders>((resolve, reject) => {
      reqStream.once('response', resolve)
      reqStream.once('error', reject)
    })

    await new Promise((r) => reqStream.once('close', r))

    return { headers, body: Buffer.concat(chunks).toString() }
  } finally {
    client.close()
    await new Promise((r) => server.close(r))
  }
}
