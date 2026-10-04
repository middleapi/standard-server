import type { StandardLazyRequest, StandardResponse } from '@standard-server/core'
import { ErrorEvent, getEventMeta, withEventMeta } from '@standard-server/core'
import { promiseWithResolvers, sleep } from '@standard-server/shared'

import type { ClientPeer, ServerPeer } from '../src'
import {
  ClientPeer as ClientPeerClass,
  decodePeerMessage,
  encodePeerMessage,
  ServerPeer as ServerPeerClass,
} from '../src'
import type { ClientPeerSendMessage, ServerPeerSendMessage } from '../src/types'

/**
 * Wires a ClientPeer and a ServerPeer together through the real codec,
 * simulating a full-duplex connection (e.g. a WebSocket) where every
 * message crosses the wire encoded.
 *
 * With `waitForRemote`, each send resolves only after the remote side handled the message,
 * so the remote's replies arrive while the send is still in flight.
 */
function connect(
  handler: (request: StandardLazyRequest) => Promise<StandardResponse>,
  { waitForRemote = false } = {},
): { client: ClientPeer; server: ServerPeer } {
  const prefix = 'peer:'
  const wire = {} as { client: ClientPeer; server: ServerPeer }

  wire.client = new ClientPeerClass(async (message) => {
    const decoded = decodePeerMessage(await encodePeerMessage(message, { prefix }), { prefix })
    if (!decoded.matched) {
      throw new Error('Failed to decode message on the wire')
    }
    const handled = wire.server.message(decoded.message as ClientPeerSendMessage, handler)
    if (waitForRemote) {
      await handled
    } else {
      void handled.catch(() => {})
    }
  })

  wire.server = new ServerPeerClass(async (message) => {
    const decoded = decodePeerMessage(await encodePeerMessage(message, { prefix }), { prefix })
    if (!decoded.matched) {
      throw new Error('Failed to decode message on the wire')
    }
    const handled = wire.client.message(decoded.message as ServerPeerSendMessage)
    if (waitForRemote) {
      await handled
    }
  })

  return wire
}

describe('peer integration (client <-> server over encoded wire)', () => {
  it('completes a JSON request/response cycle', async () => {
    const { client } = connect(async (request) => ({
      status: 201,
      headers: { 'x-served-by': 'peer' },
      body: { echo: await request.resolveBody(), url: request.url, method: request.method },
    }))

    const response = await client.request({
      url: '/greet',
      method: 'PUT',
      headers: { 'x-request': '1' },
      body: { name: 'Alice' },
    })

    expect(response.status).toBe(201)
    expect(response.headers['x-served-by']).toBe('peer')
    expect(await response.resolveBody()).toEqual({
      echo: { name: 'Alice' },
      url: '/greet',
      method: 'PUT',
    })
  })

  it('completes when the transport waits for full remote processing before send resolves', async () => {
    const { client } = connect(
      async (request) => ({
        status: 200,
        headers: {},
        body: { pong: request.url },
      }),
      { waitForRemote: true },
    )

    const response = await client.request({ url: '/ping', method: 'GET', headers: {} })
    expect(response.status).toBe(200)
    expect(await response.resolveBody()).toEqual({ pong: '/ping' })
  })

  it('handles multiple concurrent requests over the same connection', async () => {
    const { client } = connect(async (request) => ({
      status: 200,
      headers: {},
      body: `served:${request.url}`,
    }))

    const responses = await Promise.all(
      (['/a', '/b', '/c'] as const).map(async (url) => {
        const response = await client.request({ url, method: 'GET', headers: {} })
        return response.resolveBody()
      }),
    )

    expect(responses).toEqual(['served:/a', 'served:/b', 'served:/c'])
  })

  it('uploads and downloads files with binary content intact', async () => {
    const { client } = connect(async (request) => {
      const file = (await request.resolveBody()) as File
      return {
        status: 200,
        headers: {},
        body: new File([await file.text(), ' (served)'], `served-${file.name}`, {
          type: file.type,
        }),
      }
    })

    const response = await client.request({
      url: '/file',
      method: 'POST',
      headers: {},
      body: new File(['hello'], 'hello.txt', { type: 'text/plain' }),
    })

    const body = (await response.resolveBody()) as File
    expect(body).toBeInstanceOf(File)
    expect(body.name).toBe('served-hello.txt')
    expect(body.type).toBe('text/plain')
    expect(await body.text()).toBe('hello (served)')
  })

  it('round-trips multipart form data including file entries', async () => {
    const { client } = connect(async (request) => ({
      status: 200,
      headers: {},
      body: (await request.resolveBody()) as FormData,
    }))

    const form = new FormData()
    form.append('note', 'hello')
    form.append('attachment', new File(['data'], 'a.txt', { type: 'text/plain' }))

    const response = await client.request({ url: '/form', method: 'POST', headers: {}, body: form })
    const received = (await response.resolveBody()) as FormData

    expect(received).toBeInstanceOf(FormData)
    expect(received.get('note')).toBe('hello')
    const attachment = received.get('attachment') as File
    expect(attachment.name).toBe('a.txt')
    expect(await attachment.text()).toBe('data')
  })

  it('round-trips URLSearchParams', async () => {
    const { client } = connect(async (request) => ({
      status: 200,
      headers: {},
      body: (await request.resolveBody()) as URLSearchParams,
    }))

    const response = await client.request({
      url: '/search',
      method: 'POST',
      headers: {},
      body: new URLSearchParams('a=1&b=hello world'),
    })

    const received = (await response.resolveBody()) as URLSearchParams
    expect(received).toBeInstanceOf(URLSearchParams)
    expect(received.get('a')).toBe('1')
    expect(received.get('b')).toBe('hello world')
  })

  it('streams server events to the client with metadata', async () => {
    const { client } = connect(async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield withEventMeta({ step: 1 }, { id: 'e1' })
        yield { step: 2 }
        return { total: 2 }
      })(),
    }))

    const response = await client.request({ url: '/events', method: 'GET', headers: {} })
    const iterator = (await response.resolveBody()) as AsyncIterator<unknown>

    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toEqual({ step: 1 })
    expect(getEventMeta(first.value)).toEqual({ id: 'e1' })

    const second = await iterator.next()
    expect(second.done).toBe(false)
    expect(second.value).toEqual({ step: 2 })

    const last = await iterator.next()
    expect(last.done).toBe(true)
    expect(last.value).toEqual({ total: 2 })
  })

  it('propagates ErrorEvent from server stream to client iterator', async () => {
    const { client } = connect(async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield 'ok'
        throw new ErrorEvent({ code: 'BOOM' })
      })(),
    }))

    const response = await client.request({ url: '/events', method: 'GET', headers: {} })
    const iterator = (await response.resolveBody()) as AsyncIterator<unknown>

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'ok' })
    await expect(iterator.next()).rejects.toSatisfy((error: ErrorEvent) => {
      expect(error).toBeInstanceOf(ErrorEvent)
      expect(error.data).toEqual({ code: 'BOOM' })
      return true
    })
  })

  it('streams client events to the server', async () => {
    const received: unknown[] = []

    const { client } = connect(async (request) => {
      const iterator = (await request.resolveBody()) as AsyncIterator<unknown>
      let result = await iterator.next()
      while (!result.done) {
        received.push(result.value)
        result = await iterator.next()
      }
      return { status: 200, headers: {}, body: { count: received.length } }
    })

    const response = await client.request({
      url: '/ingest',
      method: 'POST',
      headers: {},
      body: (async function* () {
        yield 'a'
        yield 'b'
      })(),
    })

    expect(await response.resolveBody()).toEqual({ count: 2 })
    expect(received).toEqual(['a', 'b'])
  })

  it('streams binary chunks from server to client', async () => {
    const { client } = connect(async () => ({
      status: 200,
      headers: {},
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          controller.enqueue(new Uint8Array([3]))
          controller.close()
        },
      }),
    }))

    const response = await client.request({ url: '/download', method: 'GET', headers: {} })
    const stream = (await response.resolveBody()) as ReadableStream<Uint8Array>
    expect(stream).toBeInstanceOf(ReadableStream)

    const reader = stream.getReader()
    const chunks: number[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      chunks.push(...value)
    }

    expect(chunks).toEqual([1, 2, 3])
  })

  it('streams binary chunks in both directions when content-type is removed', async () => {
    async function readAll(stream: ReadableStream<Uint8Array>): Promise<number[]> {
      const chunks: number[] = []
      for await (const chunk of stream) {
        chunks.push(...chunk)
      }
      return chunks
    }

    let received: unknown
    let requestContentType: unknown

    const { client } = connect(async (request) => {
      requestContentType = request.headers['content-type']
      received = await request.resolveBody()

      return {
        status: 200,
        headers: { 'content-type': [] },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([4, 5]))
            controller.close()
          },
        }),
      }
    })

    const response = await client.request({
      url: '/upload',
      method: 'POST',
      headers: { 'content-type': [] },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          controller.enqueue(new Uint8Array([3]))
          controller.close()
        },
      }),
    })

    expect(requestContentType).toEqual([])
    expect(received).toBeInstanceOf(ReadableStream)
    expect(await readAll(received as ReadableStream<Uint8Array>)).toEqual([1, 2, 3])

    expect(response.headers['content-type']).toEqual([])
    const body = await response.resolveBody()
    expect(body).toBeInstanceOf(ReadableStream)
    expect(await readAll(body as ReadableStream<Uint8Array>)).toEqual([4, 5])
  })

  it('does not upload a request body the server cancelled while the request message was still being sent', async () => {
    const { client } = connect(
      async (request) => {
        await ((await request.resolveBody()) as ReadableStream).cancel()
        // a streamed response keeps the request open after the request `send` resolves
        return { status: 200, headers: {}, body: (async function* () {})() }
      },
      { waitForRemote: true },
    )

    const cancel = vi.fn()
    await client.request({
      url: '/upload',
      method: 'POST',
      headers: {},
      body: new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(new Uint8Array([1, 2])),
        cancel,
      }),
    })

    await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
  })

  describe('when send resolves only after the remote handled the message', () => {
    function endlessEvents(finished: () => void) {
      return (async function* () {
        try {
          while (true) {
            yield 'tick'
            await sleep(1)
          }
        } finally {
          finished()
        }
      })()
    }

    it('uploads an event-stream request body that the handler reads before responding', async () => {
      const { client } = connect(
        async (request) => {
          const received: unknown[] = []
          for await (const value of (await request.resolveBody()) as AsyncIterable<unknown>) {
            received.push(value)
          }
          return { status: 200, headers: {}, body: received }
        },
        { waitForRemote: true },
      )

      const response = await client.request({
        url: '/ingest',
        method: 'POST',
        headers: {},
        body: (async function* () {
          yield 'a'
          yield 'b'
        })(),
      })

      expect(await response.resolveBody()).toEqual(['a', 'b'])
    })

    it('uploads an octet-stream request body that the handler reads before responding', async () => {
      const { client } = connect(
        async (request) => {
          const received: number[] = []
          for await (const chunk of (await request.resolveBody()) as ReadableStream<Uint8Array>) {
            received.push(...chunk)
          }
          return { status: 200, headers: {}, body: received }
        },
        { waitForRemote: true },
      )

      const response = await client.request({
        url: '/upload',
        method: 'POST',
        headers: {},
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]))
            controller.enqueue(new Uint8Array([3]))
            controller.close()
          },
        }),
      })

      expect(await response.resolveBody()).toEqual([1, 2, 3])
    })

    it('propagates a client abort to a handler that has not responded yet', async () => {
      let serverSignal: AbortSignal | undefined

      const { client } = connect(
        async (request) => {
          serverSignal = request.signal
          // the handler only settles once aborted
          return new Promise((_, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal?.reason))
          })
        },
        { waitForRemote: true },
      )

      const controller = new AbortController()
      const promise = client.request({
        url: '/slow',
        method: 'GET',
        headers: {},
        signal: controller.signal,
      })

      await vi.waitFor(() => expect(serverSignal).toBeDefined())
      controller.abort(new Error('user navigated away'))

      await expect(promise).rejects.toThrow('user navigated away')
      await vi.waitFor(() => expect(serverSignal!.aborted).toBe(true))
    })

    it('propagates a client abort to an endless event-stream response', async () => {
      const finished = promiseWithResolvers<void>()
      let serverSignal: AbortSignal | undefined

      const { client } = connect(
        async (request) => {
          serverSignal = request.signal
          return { status: 200, headers: {}, body: endlessEvents(finished.resolve) }
        },
        { waitForRemote: true },
      )

      const controller = new AbortController()
      const response = await client.request({
        url: '/ticks',
        method: 'GET',
        headers: {},
        signal: controller.signal,
      })
      const iterator = (await response.resolveBody()) as AsyncIterator<unknown>
      await expect(iterator.next()).resolves.toEqual({ done: false, value: 'tick' })

      controller.abort(new Error('user navigated away'))

      await finished.promise
      expect(serverSignal!.aborted).toBe(true)
    })

    it('cancels an endless event-stream response when the client stops iterating', async () => {
      const finished = promiseWithResolvers<void>()
      let serverSignal: AbortSignal | undefined

      const { client } = connect(
        async (request) => {
          serverSignal = request.signal
          return { status: 200, headers: {}, body: endlessEvents(finished.resolve) }
        },
        { waitForRemote: true },
      )

      const response = await client.request({ url: '/ticks', method: 'GET', headers: {} })
      const iterator = (await response.resolveBody()) as AsyncIterator<unknown>
      await expect(iterator.next()).resolves.toEqual({ done: false, value: 'tick' })

      await iterator.return?.()

      await finished.promise
      expect(serverSignal!.aborted).toBe(true)
    })

    it('cancels an endless octet-stream response when the client cancels the stream', async () => {
      const cancelled = promiseWithResolvers<void>()

      const { client } = connect(
        async () => ({
          status: 200,
          headers: {},
          body: new ReadableStream<Uint8Array>({
            async pull(controller) {
              await sleep(1)
              controller.enqueue(new Uint8Array([1]))
            },
            cancel: () => cancelled.resolve(),
          }),
        }),
        { waitForRemote: true },
      )

      const response = await client.request({ url: '/bytes', method: 'GET', headers: {} })
      const reader = ((await response.resolveBody()) as ReadableStream<Uint8Array>).getReader()
      await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([1]) })

      await reader.cancel()

      await cancelled.promise
    })
  })

  it('propagates client aborts to the server handler signal', async () => {
    let serverSignal: AbortSignal | undefined

    const { client } = connect(async (request) => {
      serverSignal = request.signal
      return new Promise(() => {}) // handler never resolves
    })

    const controller = new AbortController()
    const promise = client.request({
      url: '/slow',
      method: 'GET',
      headers: {},
      signal: controller.signal,
    })

    await vi.waitFor(() => expect(serverSignal).toBeDefined())
    controller.abort(new Error('user navigated away'))

    await expect(promise).rejects.toThrow('user navigated away')
    await vi.waitFor(() => expect(serverSignal!.aborted).toBe(true))
  })

  it('releases the server request when the client fails to stream a body after sending the request', async () => {
    let serverSignal: AbortSignal | undefined

    const { client, server } = connect(async (request) => {
      serverSignal = request.signal
      // blocks until the upload ends or the request is cancelled
      await ((await request.resolveBody()) as ReadableStream).getReader().read()
      return { status: 200, headers: {} }
    })

    // a body the caller already locked cannot be streamed once the request message is out
    const body = new ReadableStream<Uint8Array>()
    body.getReader()

    await expect(
      client.request({ url: '/upload', method: 'POST', headers: {}, body }),
    ).rejects.toThrow(TypeError)

    await vi.waitFor(() => expect(serverSignal?.aborted).toBe(true))
    expect((server as any).requests.size).toBe(0)
  })

  it('propagates a client abort fired while the request message is still being sent', async () => {
    const encodeStarted = promiseWithResolvers<void>()
    const releaseEncode = promiseWithResolvers<void>()
    let serverSignal: AbortSignal | undefined

    const { client } = connect(async (request) => {
      serverSignal = request.signal
      return new Promise(() => {}) // handler never resolves
    })

    // encoding the request message awaits `file.arrayBuffer()`, so the cancel message could overtake it
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    const arrayBuffer = file.arrayBuffer.bind(file)
    vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
      encodeStarted.resolve()
      await releaseEncode.promise
      return arrayBuffer()
    })

    const controller = new AbortController()
    const promise = client.request({
      url: '/upload',
      method: 'POST',
      headers: {},
      body: file,
      signal: controller.signal,
    })

    await encodeStarted.promise
    controller.abort(new Error('user navigated away'))
    await expect(promise).rejects.toThrow('user navigated away')

    releaseEncode.resolve()
    await vi.waitFor(() => expect(serverSignal?.aborted).toBe(true))
  })

  it('carries malicious __proto__ payloads as inert data without polluting prototypes', async () => {
    let serverBody: Record<string, unknown> | undefined

    const { client } = connect(async (request) => {
      serverBody = (await request.resolveBody()) as Record<string, unknown>
      return { status: 200, headers: {}, body: serverBody }
    })

    const maliciousBody = JSON.parse('{"user":"alice","__proto__":{"isAdmin":true}}')
    const response = await client.request({
      url: '/login',
      method: 'POST',
      headers: {},
      body: maliciousBody,
    })
    const echoed = (await response.resolveBody()) as Record<string, unknown>

    expect(serverBody!.user).toBe('alice')
    expect(Object.getOwnPropertyDescriptor(serverBody, '__proto__')?.value).toEqual({
      isAdmin: true,
    })
    expect(Object.getOwnPropertyDescriptor(echoed, '__proto__')?.value).toEqual({ isAdmin: true })
    expect(({} as any).isAdmin).toBeUndefined()
    expect(Object.getPrototypeOf(serverBody)).toBe(Object.prototype)
  })
})
