import http from 'node:http'
import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import Stream from 'node:stream'
import { text } from 'node:stream/consumers'

import { AbortError } from '@standard-server/shared'

import { toAbortSignal } from './signal'

describe('toAbortSignal', async () => {
  it('on success', async () => {
    const stream = new Stream.Writable({
      write(chunk, encoding, callback) {
        callback()
      },
    })

    const signal = toAbortSignal(stream)

    expect(signal.aborted).toBe(false)

    stream.end('test')

    await new Promise((r) => setTimeout(r, 100))

    expect(signal.aborted).toBe(false)
  })

  it('on error', async () => {
    const stream = new Stream.Writable({
      write(chunk, encoding, callback) {
        callback()
      },
    })

    // catch error
    stream.on('error', () => {})

    const signal = toAbortSignal(stream)

    expect(signal.aborted).toBe(false)

    stream.destroy(new Error('test'))

    await vi.waitFor(() => {
      expect(signal.aborted).toEqual(true)
      expect(signal.reason).toEqual(new Error('test'))
    })
  })

  it('on writableFinished=false', async () => {
    const stream = new Stream.Writable({
      write(chunk, encoding, callback) {},
    })

    const signal = toAbortSignal(stream)

    expect(signal.aborted).toBe(false)

    stream.write('test')
    stream.destroy()

    await vi.waitFor(() => {
      expect(signal.aborted).toEqual(true)
      expect(signal.reason).toEqual(
        new AbortError('Writable stream closed before it finished writing'),
      )
    })
  })

  it('on already errored', async () => {
    const stream = new Stream.Writable({
      write(chunk, encoding, callback) {
        callback()
      },
    })

    // catch error
    stream.on('error', () => {})

    stream.destroy(new Error('test'))

    const signal = toAbortSignal(stream)

    expect(signal.aborted).toBe(true)
    expect(signal.reason).toEqual(new Error('test'))
  })

  it('on already closed before finished', async () => {
    const stream = new Stream.Writable({
      write(chunk, encoding, callback) {},
    })

    stream.write('test')
    stream.destroy()

    const signal = toAbortSignal(stream)

    expect(signal.aborted).toBe(true)
    expect(signal.reason).toEqual(
      new AbortError('Writable stream closed before it finished writing'),
    )
  })

  it('on http2 response with underlying stream already closed', async ({ onTestFinished }) => {
    const server = http2.createServer()
    onTestFinished(() => new Promise<any>((r) => server.close(r)))

    const handled = new Promise<void>((resolve, reject) => {
      server.on('request', async (req, res) => {
        try {
          // simulate a procedure still running when the client disconnects
          await new Promise<void>((r) => res.stream.once('close', () => r()))

          const signal = toAbortSignal(res)

          expect(signal.aborted).toBe(true)
          expect(signal.reason).toEqual(
            new AbortError('Writable stream closed before it finished writing'),
          )

          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })

    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as any).port

    const client = http2.connect(`http://localhost:${port}`)
    const reqStream = client.request({ ':path': '/' })
    reqStream.once('error', () => {})

    setTimeout(() => {
      reqStream.close(http2.constants.NGHTTP2_CANCEL)
      client.close()
    }, 50)

    await handled
  })

  it('on http2 response with underlying stream already errored', async ({ onTestFinished }) => {
    const server = http2.createServer()
    onTestFinished(() => new Promise<any>((r) => server.close(r)))

    const error = new Error('test')

    const handled = new Promise<void>((resolve, reject) => {
      server.on('request', async (req, res) => {
        try {
          // catch error
          res.stream.once('error', () => {})
          res.stream.destroy(error)

          await new Promise<void>((r) => res.stream.once('close', () => r()))

          const signal = toAbortSignal(res)

          expect(signal.aborted).toBe(true)
          expect(signal.reason).toBe(error)

          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })

    await new Promise<void>((r) => server.listen(0, r))
    const port = (server.address() as any).port

    const client = http2.connect(`http://localhost:${port}`)
    const reqStream = client.request({ ':path': '/' })
    reqStream.once('error', () => client.close())

    await handled
  })

  describe('on http2 HEAD response, whose stream Node already ended', () => {
    it('without abort', async ({ onTestFinished }) => {
      const server = http2.createServer()
      onTestFinished(() => new Promise<any>((r) => server.close(r)))

      const handled = new Promise<void>((resolve, reject) => {
        server.on('request', async (req, res) => {
          try {
            const signal = toAbortSignal(res)

            expect(signal.aborted).toBe(false)

            res.end()
            await new Promise<void>((r) => res.stream.once('close', () => r()))

            expect(signal.aborted).toBe(false)

            resolve()
          } catch (error) {
            reject(error)
          }
        })
      })

      await new Promise<void>((r) => server.listen(0, r))
      const port = (server.address() as any).port

      const client = http2.connect(`http://localhost:${port}`)
      const reqStream = client.request({ ':path': '/', ':method': 'HEAD' })
      reqStream.resume()
      reqStream.once('close', () => client.close())

      await handled
    })

    it('aborted by client before the response ends', async ({ onTestFinished }) => {
      const server = http2.createServer()
      onTestFinished(() => new Promise<any>((r) => server.close(r)))

      const handled = new Promise<void>((resolve, reject) => {
        server.on('request', async (req, res) => {
          try {
            const signal = toAbortSignal(res)

            expect(signal.aborted).toBe(false)

            await new Promise<void>((r) => res.stream.once('close', () => r()))

            expect(signal.aborted).toBe(true)
            expect(signal.reason).toEqual(
              new AbortError('Writable stream closed before it finished writing'),
            )

            resolve()
          } catch (error) {
            reject(error)
          }
        })
      })

      await new Promise<void>((r) => server.listen(0, r))
      const port = (server.address() as any).port

      const client = http2.connect(`http://localhost:${port}`)
      const reqStream = client.request({ ':path': '/', ':method': 'HEAD' })
      reqStream.once('error', () => {})

      setTimeout(() => {
        reqStream.close(http2.constants.NGHTTP2_CANCEL)
        client.close()
      }, 50)

      await handled
    })
  })

  describe('on pipelined http1 requests', () => {
    // Node only gives the socket to the first request: the responses queued behind it never
    // emit `close` or `error` when the client disconnects, only their requests error
    const PIPELINED = 20

    async function listen(
      onTestFinished: (fn: () => Promise<any>) => void,
      listener: http.RequestListener,
    ): Promise<number> {
      const server = http.createServer(listener)
      onTestFinished(
        () =>
          new Promise<any>((r) => {
            server.closeAllConnections()
            server.close(r)
          }),
      )

      await new Promise<void>((r) => server.listen(0, r))
      return (server.address() as AddressInfo).port
    }

    it('aborts every queued request when the client disconnects', async ({ onTestFinished }) => {
      const signals: AbortSignal[] = []

      const port = await listen(onTestFinished, (req, res) => {
        signals.push(toAbortSignal(res))
      })

      const socket = net.connect(port, '127.0.0.1')
      socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'.repeat(PIPELINED))

      await vi.waitFor(() => expect(signals).toHaveLength(PIPELINED))
      expect(signals.filter((signal) => signal.aborted)).toHaveLength(0)

      socket.destroy()

      await vi.waitFor(() => {
        expect(signals.filter((signal) => signal.aborted)).toHaveLength(PIPELINED)
      })

      for (const signal of signals) {
        expect(signal.reason).toEqual(
          new AbortError('Writable stream closed before it finished writing'),
        )
      }
    })

    it('on queued request already errored', async ({ onTestFinished }) => {
      const signals: AbortSignal[] = []

      const port = await listen(onTestFinished, async (req, res) => {
        // the request errors once the client disconnects, the queued response stays open
        await new Promise((r) => req.once('close', r))
        signals.push(toAbortSignal(res))
      })

      const socket = net.connect(port, '127.0.0.1')
      socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'.repeat(PIPELINED))
      setTimeout(() => socket.destroy(), 50)

      await vi.waitFor(() => expect(signals).toHaveLength(PIPELINED))

      for (const signal of signals) {
        expect(signal.aborted).toBe(true)
        expect(signal.reason).toEqual(
          new AbortError('Writable stream closed before it finished writing'),
        )
      }
    })

    it('does not abort requests that read their body and end', async ({ onTestFinished }) => {
      const signals: AbortSignal[] = []

      const port = await listen(onTestFinished, async (req, res) => {
        const signal = toAbortSignal(res)
        signals.push(signal)

        const body = await text(req)

        // the request closes, without an error, before the response ends
        await vi.waitFor(() => expect(req.closed).toBe(true))
        expect(req.errored).toBe(null)
        expect(signal.aborted).toBe(false)

        res.end(body)
      })

      const socket = net.connect(port, '127.0.0.1')
      for (let i = 0; i < 3; i++) {
        socket.write(
          `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n${i === 2 ? 'Connection: close\r\n' : ''}\r\nbody`,
        )
      }

      const received = await text(socket)

      expect(received.match(/HTTP\/1\.1 200 /g)).toHaveLength(3)
      expect(signals).toHaveLength(3)

      await new Promise((r) => setTimeout(r, 50))

      for (const signal of signals) {
        expect(signal.aborted).toBe(false)
      }
    })
  })
})
