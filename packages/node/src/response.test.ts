import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import http from 'node:http'
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import Stream from 'node:stream'

import type { StandardBody, StandardResponse } from '@standard-server/core'
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
      ;(responseStream as any).writeHead = vi.fn()

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
      ;(responseStream as any).writeHead = vi.fn()

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

      const response = await requestHttp2((_, res) => {
        sending = sendStandardResponse(res, {
          status: 201,
          headers: { 'x-custom-header': 'custom-value' },
          body: undefined,
        })
      }, 'HEAD')

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

      const response = await requestHttp2((_, res) => {
        sending = sendStandardResponse(res, { status: 201, headers: {}, body })
        sending.catch(() => {})
      }, 'HEAD')

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

  /**
   * Node validates some of the head only when committing it, which a stream body
   * would otherwise leave to its first piped write, out of reach of the Promise.
   */
  describe('head rejected when committed', () => {
    const createFile = () => new File(['foo'], 'foo.txt', { type: 'text/plain' })
    const createEventStream = () =>
      (async function* () {
        yield 'foo'
      })()

    const streamBodies: [string, () => StandardBody][] = [
      [
        'readable stream',
        () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('foo'))
              controller.close()
            },
          }),
      ],
      ['file', createFile],
      [
        'form data',
        () => {
          const formData = new FormData()
          formData.append('foo', 'bar')
          return formData
        },
      ],
      ['event stream', createEventStream],
    ]

    async function expectHttp1Rejection(response: StandardResponse, code: string) {
      let destroySpy: any
      let thrownError: any

      await expect(
        request(async (req: IncomingMessage, res: ServerResponse) => {
          destroySpy = vi.spyOn(res, 'destroy')

          try {
            await sendStandardResponse(res, response)
          } catch (err) {
            thrownError = err
          }
        }).get('/'),
      ).rejects.toThrow()

      expect(thrownError).toBeInstanceOf(Error)
      expect(thrownError.code).toBe(code)

      expect(destroySpy).toHaveBeenCalledWith(thrownError)

      const [resBody] = toNodeHttpBodySpy.mock.results[0]!.value
      expect((resBody as any).destroyed).toBe(true)
    }

    describe.each([1000, 99, Number.NaN])('status %s', (status) => {
      it.each(streamBodies)('rejects, destroys the response and the body (%s)', (_, createBody) =>
        expectHttp1Rejection(
          { status, headers: {}, body: createBody() },
          'ERR_HTTP_INVALID_STATUS_CODE',
        ),
      )
    })

    it.each([
      ['keep-alive', 'timeout=5'],
      ['transfer-encoding', 'chunked'],
      ['te', 'gzip'],
      ['upgrade', 'websocket'],
    ])(
      'rejects an http2 connection-specific header (%s) and resets the stream',
      async (name, value) => {
        const { body, cancel } = createOpenStream()
        let sending: Promise<void> | undefined

        const { rstCode } = await requestHttp2((_, res) => {
          sending = sendStandardResponse(res, { status: 200, headers: { [name]: value }, body })
          sending.catch(() => {})
        })

        await expect(sending).rejects.toMatchObject({
          code: 'ERR_HTTP2_INVALID_CONNECTION_HEADERS',
        })

        expect(rstCode).toBe(http2.constants.NGHTTP2_INTERNAL_ERROR)

        await vi.waitFor(() => {
          expect(cancel).toHaveBeenCalledTimes(1)
        })
      },
    )

    it.each([
      ['file', createFile],
      ['event stream', createEventStream],
    ])('rejects repeated values for an http2 single-value header (%s)', async (_, createBody) => {
      let sending: Promise<void> | undefined

      const { rstCode } = await requestHttp2((_, res) => {
        sending = sendStandardResponse(res, {
          status: 200,
          headers: { 'x-content-type-options': ['nosniff', 'nosniff'] },
          body: createBody(),
        })
        sending.catch(() => {})
      })

      await expect(sending).rejects.toMatchObject({ code: 'ERR_HTTP2_HEADER_SINGLE_VALUE' })

      expect(rstCode).toBe(http2.constants.NGHTTP2_INTERNAL_ERROR)

      const [resBody] = toNodeHttpBodySpy.mock.results[0]!.value
      expect((resBody as any).destroyed).toBe(true)
    })

    it('rejects an http1 trailer header with a file body (sent with a content-length)', () =>
      expectHttp1Rejection(
        { status: 200, headers: { trailer: 'x-checksum' }, body: createFile() },
        'ERR_HTTP_TRAILER_INVALID',
      ))

    it('rejects an http1 trailer header with a stream body over http/1.0 (not chunked)', async () => {
      const { body, cancel } = createOpenStream()
      let sending: Promise<void> | undefined

      const server = http.createServer((req, res) => {
        sending = sendStandardResponse(res, {
          status: 200,
          headers: { trailer: 'x-checksum' },
          body,
        })
        sending.catch(() => {})
      })
      await new Promise<void>((r) => server.listen(0, r))

      try {
        const socket = net.connect((server.address() as AddressInfo).port)
        socket.once('error', () => {})
        socket.write('GET / HTTP/1.0\r\n\r\n')

        const chunks: Buffer[] = []
        socket.on('data', (chunk: Buffer) => chunks.push(chunk))
        await new Promise((r) => socket.once('close', r))

        await expect(sending).rejects.toMatchObject({ code: 'ERR_HTTP_TRAILER_INVALID' })

        // the connection is dropped before any byte of the head is sent
        expect(Buffer.concat(chunks).toString()).toBe('')

        await vi.waitFor(() => {
          expect(cancel).toHaveBeenCalledTimes(1)
        })
      } finally {
        await new Promise((r) => server.close(r))
      }
    })
  })
})

/**
 * A stream body that never ends on its own, so it is only released by being destroyed.
 */
function createOpenStream() {
  const cancel = vi.fn()

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('foo'))
    },
    cancel,
  })

  return { body, cancel }
}

async function requestHttp2(
  listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
  method = 'GET',
): Promise<{ headers?: http2.IncomingHttpHeaders; body: string; rstCode: number | undefined }> {
  const server = http2.createServer(listener)
  await new Promise<void>((r) => server.listen(0, r))

  const client = http2.connect(`http://localhost:${(server.address() as AddressInfo).port}`)

  try {
    const reqStream = client.request({ ':path': '/', ':method': method })
    // a stream reset by the server errors; tests assert on `rstCode` instead
    reqStream.once('error', () => {})

    let headers: http2.IncomingHttpHeaders | undefined
    reqStream.once('response', (responseHeaders) => {
      headers = responseHeaders
    })

    const chunks: Buffer[] = []
    reqStream.on('data', (chunk: Buffer) => chunks.push(chunk))

    await new Promise((r) => reqStream.once('close', r))

    return { headers, body: Buffer.concat(chunks).toString(), rstCode: reqStream.rstCode }
  } finally {
    client.close()
    await new Promise((r) => server.close(r))
  }
}
