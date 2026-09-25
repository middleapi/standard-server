import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import http, { createServer } from 'node:http'
import http2, { createServer as createHttp2Server, connect as http2Connect } from 'node:http2'
import net, { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { canWriteToNodeResponse, getNodeResponseError, toWebReadableStream } from './utils'

describe('canWriteToNodeResponse', () => {
  it('on http1 response aborted by client', async ({ onTestFinished }) => {
    const server = http.createServer()
    onTestFinished(() => new Promise<any>(r => server.close(r)))

    const handled = new Promise<void>((resolve, reject) => {
      server.on('request', async (req, res) => {
        try {
          expect(canWriteToNodeResponse(res)).toBe(true)

          await new Promise<void>(r => res.once('close', () => r()))

          expect(canWriteToNodeResponse(res)).toBe(false)

          resolve()
        }
        catch (error) {
          reject(error)
        }
      })
    })

    await new Promise<void>(r => server.listen(0, r))
    const port = (server.address() as any).port

    const socket = connect(port, '127.0.0.1', () => {
      socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')

      setTimeout(() => {
        socket.destroy()
      }, 50)
    })

    await handled
  })

  it('on http1 response finished normally', async ({ onTestFinished }) => {
    const server = http.createServer()
    onTestFinished(() => new Promise<any>(r => server.close(r)))

    const handled = new Promise<void>((resolve, reject) => {
      server.on('request', async (req, res) => {
        try {
          expect(canWriteToNodeResponse(res)).toBe(true)

          res.end('ok')

          await vi.waitFor(() => {
            expect(canWriteToNodeResponse(res)).toBe(false)
          })

          resolve()
        }
        catch (error) {
          reject(error)
        }
      })
    })

    await new Promise<void>(r => server.listen(0, r))
    const port = (server.address() as any).port

    http.get(`http://localhost:${port}`, res => res.resume())

    await handled
  })

  it('on http1 response with headers already flushed', async ({ onTestFinished }) => {
    const server = http.createServer()
    onTestFinished(() => new Promise<any>(r => server.close(r)))

    const handled = new Promise<void>((resolve, reject) => {
      server.on('request', async (req, res) => {
        try {
          expect(canWriteToNodeResponse(res)).toBe(true)

          res.flushHeaders()

          expect(res.headersSent).toBe(true)
          expect(canWriteToNodeResponse(res)).toBe(false)

          res.end()

          resolve()
        }
        catch (error) {
          reject(error)
        }
      })
    })

    await new Promise<void>(r => server.listen(0, r))
    const port = (server.address() as any).port

    http.get(`http://localhost:${port}`, res => res.resume())

    await handled
  })

  it('on http2 response aborted by client', async ({ onTestFinished }) => {
    const server = http2.createServer()
    onTestFinished(() => new Promise<any>(r => server.close(r)))

    const handled = new Promise<void>((resolve, reject) => {
      server.on('request', async (req, res) => {
        try {
          expect(canWriteToNodeResponse(res)).toBe(true)

          await new Promise<void>(r => res.stream.once('close', () => r()))

          expect(canWriteToNodeResponse(res)).toBe(false)

          resolve()
        }
        catch (error) {
          reject(error)
        }
      })
    })

    await new Promise<void>(r => server.listen(0, r))
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

  it('on http2 response finished normally', async ({ onTestFinished }) => {
    const server = http2.createServer()
    onTestFinished(() => new Promise<any>(r => server.close(r)))

    const handled = new Promise<void>((resolve, reject) => {
      server.on('request', async (req, res) => {
        try {
          expect(canWriteToNodeResponse(res)).toBe(true)

          res.end('ok')

          await vi.waitFor(() => {
            expect(canWriteToNodeResponse(res)).toBe(false)
          })

          resolve()
        }
        catch (error) {
          reject(error)
        }
      })
    })

    await new Promise<void>(r => server.listen(0, r))
    const port = (server.address() as any).port

    const client = http2.connect(`http://localhost:${port}`)
    const reqStream = client.request({ ':path': '/' })
    reqStream.on('data', () => {})
    reqStream.once('end', () => client.close())

    await handled
  })
})

describe('getNodeResponseError', () => {
  it('on http1 response destroyed with an error', async ({ onTestFinished }) => {
    const server = http.createServer()
    onTestFinished(() => new Promise<any>(r => server.close(r)))

    const error = new Error('test')

    const handled = new Promise<void>((resolve, reject) => {
      server.on('request', async (req, res) => {
        try {
          expect(getNodeResponseError(res)).toBe(null)

          // catch error
          res.once('error', () => {})
          res.destroy(error)

          await new Promise<void>(r => res.once('close', () => r()))

          expect(getNodeResponseError(res)).toBe(error)

          resolve()
        }
        catch (error) {
          reject(error)
        }
      })
    })

    await new Promise<void>(r => server.listen(0, r))
    const port = (server.address() as any).port

    http.get(`http://localhost:${port}`, res => res.resume()).once('error', () => {})

    await handled
  })

  it('on http1 response finished normally', async ({ onTestFinished }) => {
    const server = http.createServer()
    onTestFinished(() => new Promise<any>(r => server.close(r)))

    const handled = new Promise<void>((resolve, reject) => {
      server.on('request', async (req, res) => {
        try {
          res.end('ok')

          await new Promise<void>(r => res.once('close', () => r()))

          expect(getNodeResponseError(res)).toBe(null)

          resolve()
        }
        catch (error) {
          reject(error)
        }
      })
    })

    await new Promise<void>(r => server.listen(0, r))
    const port = (server.address() as any).port

    http.get(`http://localhost:${port}`, res => res.resume())

    await handled
  })

  it('on http2 response destroyed with an error', async ({ onTestFinished }) => {
    const server = http2.createServer()
    onTestFinished(() => new Promise<any>(r => server.close(r)))

    const error = new Error('test')

    const handled = new Promise<void>((resolve, reject) => {
      server.on('request', async (req, res) => {
        try {
          expect(getNodeResponseError(res)).toBe(null)

          // catch error
          res.stream.once('error', () => {})
          res.stream.destroy(error)

          await new Promise<void>(r => res.stream.once('close', () => r()))

          expect(getNodeResponseError(res)).toBe(error)

          // `Http2ServerResponse` extends `Stream`, not `Writable`, so the error is only
          // reachable through the underlying `Http2Stream` - reading it off the response
          // itself silently yields `undefined`, despite what `@types/node` declares
          expect((res as any).errored).toBe(undefined)

          resolve()
        }
        catch (error) {
          reject(error)
        }
      })
    })

    await new Promise<void>(r => server.listen(0, r))
    const port = (server.address() as any).port

    const client = http2.connect(`http://localhost:${port}`)
    const reqStream = client.request({ ':path': '/' })
    reqStream.once('error', () => client.close())

    await handled
  })

  it('on http2 response finished normally', async ({ onTestFinished }) => {
    const server = http2.createServer()
    onTestFinished(() => new Promise<any>(r => server.close(r)))

    const handled = new Promise<void>((resolve, reject) => {
      server.on('request', async (req, res) => {
        try {
          res.end('ok')

          await new Promise<void>(r => res.stream.once('close', () => r()))

          expect(getNodeResponseError(res)).toBe(null)

          resolve()
        }
        catch (error) {
          reject(error)
        }
      })
    })

    await new Promise<void>(r => server.listen(0, r))
    const port = (server.address() as any).port

    const client = http2.connect(`http://localhost:${port}`)
    const reqStream = client.request({ ':path': '/' })
    reqStream.on('data', () => {})
    reqStream.once('end', () => client.close())

    await handled
  })
})

describe('toWebReadableStream', () => {
  /**
   * Below the 256 KiB flood chunk, so the consumer cancels on its first read
   * while the request is still streaming — the condition that crashes a bare
   * `Readable.toWeb` before Node 26.10.
   */
  const LIMIT = 64 * 1024

  /**
   * Runs `fn` while recording `uncaughtException`/`unhandledRejection` into the
   * returned array (also passed to `fn`), so an uncatchable adapter crash lands
   * there instead of failing the worker. Restores the runner's listeners after.
   */
  async function recordUncaught(fn: (crashes: Error[]) => Promise<void>): Promise<Error[]> {
    const crashes: Error[] = []
    const record = (err: unknown): void => {
      crashes.push(err as Error)
    }

    const prevExceptions = process.listeners('uncaughtException')
    const prevRejections = process.listeners('unhandledRejection')
    process.removeAllListeners('uncaughtException')
    process.removeAllListeners('unhandledRejection')
    process.on('uncaughtException', record)
    process.on('unhandledRejection', record)

    try {
      await fn(crashes)
      // Let any queued 'data' event reach a (possibly closed) controller.
      await new Promise(resolve => setTimeout(resolve, 50))
      return crashes
    }
    finally {
      process.off('uncaughtException', record)
      process.off('unhandledRejection', record)
      prevExceptions.forEach(listener => process.on('uncaughtException', listener))
      prevRejections.forEach(listener => process.on('unhandledRejection', listener))
    }
  }

  /**
   * Consumes a body like an upload handler: spools each chunk to disk (an async
   * gap that lets more data queue up) and rejects past `LIMIT`, cancelling the
   * stream while bytes are still arriving.
   */
  async function spoolUntilRejected(body: ReadableStream<Uint8Array>, tmpDir: string): Promise<void> {
    const sink = path.join(await mkdtemp(path.join(tmpDir, 'chunk-')), 'sink')
    let total = 0
    try {
      for await (const chunk of body) {
        total += chunk.byteLength
        if (total > LIMIT) {
          throw new Error('PAYLOAD_TOO_LARGE')
        }
        await appendFile(sink, chunk)
      }
    }
    catch {
      // Mirrors the plugin turning the oversized body into a 413.
    }
  }

  /** Streams an oversized HTTP/1 upload, then destroys the socket mid-flight. */
  function floodAndAbortHttp1(port: number): Promise<void> {
    return new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 104857600\r\n\r\n')
        const blob = Buffer.alloc(256 * 1024, 0x61)
        const interval = setInterval(() => {
          if (socket.destroyed || !socket.writable) {
            clearInterval(interval)
            return
          }
          socket.write(blob)
        }, 0)
        socket.on('close', () => clearInterval(interval))
      })
      socket.on('error', () => {})
      socket.on('close', () => resolve())
      setTimeout(() => socket.destroy(), 15)
    })
  }

  /** Streams an oversized HTTP/2 upload, then destroys the request mid-flight. */
  function floodAndAbortHttp2(port: number): Promise<void> {
    return new Promise((resolve) => {
      const client = http2Connect(`http://127.0.0.1:${port}`)
      client.on('error', () => {})
      const request = client.request({ ':method': 'POST', ':path': '/', 'content-length': '104857600' })
      const blob = Buffer.alloc(256 * 1024, 0x61)
      const interval = setInterval(() => {
        if (request.destroyed || request.closed) {
          clearInterval(interval)
          return
        }
        request.write(blob)
      }, 0)
      request.on('error', () => clearInterval(interval))

      let settled = false
      const settle = (): void => {
        if (settled) {
          return
        }
        settled = true
        clearInterval(interval)
        client.destroy()
        resolve()
      }
      request.on('close', settle)
      setTimeout(() => {
        request.destroy()
        settle()
      }, 15)
    })
  }

  /**
   * Boots a server that spools each request body via `toWebReadableStream`,
   * fires `iterations` aborted uploads at it, and reports how many completed
   * plus any crashes.
   */
  async function runUploadServer(
    kind: 'http1' | 'http2',
    iterations: number,
  ): Promise<{ handled: number, crashes: Error[] }> {
    const tmpDir = await mkdtemp(path.join(tmpdir(), `toweb-${kind}-`))
    let handled = 0

    const listener = async (req: any, res: any): Promise<void> => {
      await spoolUntilRejected(toWebReadableStream(req), tmpDir)
      handled++
      try {
        if (!res.headersSent) {
          res.statusCode = 413
          res.end('too large')
        }
      }
      catch {
        // The request stream may already be torn down; the response is best effort.
      }
    }

    const server = kind === 'http1' ? createServer(listener) : createHttp2Server(listener)
    const flood = kind === 'http1' ? floodAndAbortHttp1 : floodAndAbortHttp2

    const crashes = await recordUncaught(async () => {
      await new Promise<void>(resolve => server.listen(0, resolve))
      const { port } = server.address() as AddressInfo
      for (let i = 0; i < iterations; i++) {
        await flood(port)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    })

    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(tmpDir, { recursive: true, force: true })
    return { handled, crashes }
  }

  it('converts a raw buffer stream and preserves its bytes as copies', async () => {
    const chunks = [Buffer.from('hello '), Buffer.from('world'), Buffer.alloc(1024, 7)]
    const source = Readable.from(chunks)

    const received: Uint8Array[] = []
    for await (const chunk of toWebReadableStream(source)) {
      expect(chunk).toBeInstanceOf(Uint8Array)
      expect(Buffer.isBuffer(chunk)).toBe(false) // copied out of the Node Buffer
      received.push(chunk)
    }

    expect(Buffer.concat(received).equals(Buffer.concat(chunks))).toBe(true)
  })

  it('does not throw when a raw buffer stream is cancelled mid-read', async () => {
    const source = Readable.from((async function* () {
      for (let i = 0; i < 10_000; i++) {
        yield Buffer.alloc(64 * 1024, 0x61)
      }
    })())

    let read = 0
    const crashes = await recordUncaught(async () => {
      for await (const chunk of toWebReadableStream(source)) {
        read += chunk.byteLength
        if (read >= 256 * 1024) {
          break // cancels the web stream while the source still has data
        }
      }
      await new Promise(resolve => setImmediate(resolve))
    })

    expect(crashes).toEqual([])
    expect(read).toBeGreaterThanOrEqual(256 * 1024)
    expect(source.destroyed).toBe(true) // cancellation still tears the source down
  })

  it('keeps an aborted HTTP/1 upload from crashing the process', async () => {
    const { handled, crashes } = await runUploadServer('http1', 25)

    expect(crashes).toEqual([])
    expect(handled).toBe(25)
  }, 30_000)

  it('keeps an aborted HTTP/2 upload from crashing the process', async () => {
    const { handled, crashes } = await runUploadServer('http2', 25)

    expect(crashes).toEqual([])
    expect(handled).toBe(25)
  }, 30_000)
})
