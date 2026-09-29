import type { StandardLazyRequest, StandardResponse } from '@standard-server/core'
import type { ClientPeer, ServerPeer } from '../src'
import type { ClientPeerSendMessage, PeerMessage, ServerPeerSendMessage } from '../src/types'
import { ErrorEvent, getEventMeta, withEventMeta } from '@standard-server/core'
import { promiseWithResolvers } from '@standard-server/shared'
import { ClientPeer as ClientPeerClass, decodePeerMessage, encodePeerMessage, ServerPeer as ServerPeerClass } from '../src'

interface ConnectOptions {
  /**
   * Make each `send` resolve only once the remote side has handled the message.
   */
  awaitRemote?: boolean
  /**
   * Runs before a client message is encoded, e.g. to hold it back.
   */
  beforeClientSend?: (message: ClientPeerSendMessage) => Promise<void>
}

/**
 * Wires a ClientPeer and a ServerPeer together through the real codec,
 * simulating a full-duplex connection (e.g. a WebSocket) where every
 * message crosses the wire encoded.
 */
function connect(
  handler: (request: StandardLazyRequest) => Promise<StandardResponse>,
  { awaitRemote = false, beforeClientSend }: ConnectOptions = {},
): { client: ClientPeer, server: ServerPeer } {
  const prefix = 'peer:'
  const wire = {} as { client: ClientPeer, server: ServerPeer }

  const transfer = async (message: PeerMessage): Promise<PeerMessage> => {
    const decoded = decodePeerMessage(await encodePeerMessage(message, { prefix }), { prefix })
    if (!decoded.matched) {
      throw new Error('Failed to decode message on the wire')
    }
    return decoded.message
  }

  wire.client = new ClientPeerClass(async (message) => {
    await beforeClientSend?.(message)
    const handled = wire.server.message(await transfer(message) as ClientPeerSendMessage, handler)
    if (awaitRemote) {
      await handled
    }
    else {
      void handled.catch(() => {})
    }
  })

  wire.server = new ServerPeerClass(async (message) => {
    const handled = wire.client.message(await transfer(message) as ServerPeerSendMessage)
    if (awaitRemote) {
      await handled
    }
  })

  return wire
}

describe('peer integration (client <-> server over encoded wire)', () => {
  it('completes a JSON request/response cycle', async () => {
    const { client } = connect(async request => ({
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
    expect(await response.resolveBody()).toEqual({ echo: { name: 'Alice' }, url: '/greet', method: 'PUT' })
  })

  it('completes when the transport waits for full remote processing before send resolves', async () => {
    // the response arrives while the request `send` is still in flight
    const { client } = connect(async request => ({
      status: 200,
      headers: {},
      body: { pong: request.url },
    }), { awaitRemote: true })

    const response = await client.request({ url: '/ping', method: 'GET', headers: {} })
    expect(response.status).toBe(200)
    expect(await response.resolveBody()).toEqual({ pong: '/ping' })
  })

  it('handles multiple concurrent requests over the same connection', async () => {
    const { client } = connect(async request => ({
      status: 200,
      headers: {},
      body: `served:${request.url}`,
    }))

    const responses = await Promise.all((['/a', '/b', '/c'] as const).map(async (url) => {
      const response = await client.request({ url, method: 'GET', headers: {} })
      return response.resolveBody()
    }))

    expect(responses).toEqual(['served:/a', 'served:/b', 'served:/c'])
  })

  it('uploads and downloads files with binary content intact', async () => {
    const { client } = connect(async (request) => {
      const file = await request.resolveBody() as File
      return {
        status: 200,
        headers: {},
        body: new File([await file.text(), ' (served)'], `served-${file.name}`, { type: file.type }),
      }
    })

    const response = await client.request({
      url: '/file',
      method: 'POST',
      headers: {},
      body: new File(['hello'], 'hello.txt', { type: 'text/plain' }),
    })

    const body = await response.resolveBody() as File
    expect(body).toBeInstanceOf(File)
    expect(body.name).toBe('served-hello.txt')
    expect(body.type).toBe('text/plain')
    expect(await body.text()).toBe('hello (served)')
  })

  it('round-trips multipart form data including file entries', async () => {
    const { client } = connect(async request => ({
      status: 200,
      headers: {},
      body: await request.resolveBody() as FormData,
    }))

    const form = new FormData()
    form.append('note', 'hello')
    form.append('attachment', new File(['data'], 'a.txt', { type: 'text/plain' }))

    const response = await client.request({ url: '/form', method: 'POST', headers: {}, body: form })
    const received = await response.resolveBody() as FormData

    expect(received).toBeInstanceOf(FormData)
    expect(received.get('note')).toBe('hello')
    const attachment = received.get('attachment') as File
    expect(attachment.name).toBe('a.txt')
    expect(await attachment.text()).toBe('data')
  })

  it('round-trips URLSearchParams', async () => {
    const { client } = connect(async request => ({
      status: 200,
      headers: {},
      body: await request.resolveBody() as URLSearchParams,
    }))

    const response = await client.request({
      url: '/search',
      method: 'POST',
      headers: {},
      body: new URLSearchParams('a=1&b=hello world'),
    })

    const received = await response.resolveBody() as URLSearchParams
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
    const iterator = await response.resolveBody() as AsyncIterator<unknown>

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
    const iterator = await response.resolveBody() as AsyncIterator<unknown>

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
      const iterator = await request.resolveBody() as AsyncIterator<unknown>
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
    const stream = await response.resolveBody() as ReadableStream<Uint8Array>
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

  it.each([false, true])('propagates client aborts to the server handler signal (awaitRemote: %s)', async (awaitRemote) => {
    let serverSignal: AbortSignal | undefined

    // with `awaitRemote`, the request `send` stays in flight until the handler settles
    const { client } = connect(async (request) => {
      serverSignal = request.signal
      await new Promise(resolve => request.signal!.addEventListener('abort', resolve))
      return { status: 200, headers: {}, body: 'too late' }
    }, { awaitRemote })

    const controller = new AbortController()
    const promise = client.request({ url: '/slow', method: 'GET', headers: {}, signal: controller.signal })

    await vi.waitFor(() => expect(serverSignal).toBeDefined())
    controller.abort(new Error('user navigated away'))

    await expect(promise).rejects.toThrow('user navigated away')
    await vi.waitFor(() => expect(serverSignal!.aborted).toBe(true))
  })

  it('propagates a client abort fired while the request message is still being sent', async () => {
    const requestSendStarted = promiseWithResolvers<void>()
    const requestEncoded = promiseWithResolvers<void>()
    let serverSignal: AbortSignal | undefined

    // encoding the request message (e.g. awaiting `blob.arrayBuffer()`)
    // takes longer than encoding the cancel message that follows it
    const { client } = connect(async (request) => {
      serverSignal = request.signal
      return new Promise(() => {}) // handler never resolves
    }, {
      beforeClientSend: async (message) => {
        if (message.kind === 'request') {
          requestSendStarted.resolve()
          await requestEncoded.promise
        }
      },
    })

    const controller = new AbortController()
    const promise = client.request({
      url: '/upload',
      method: 'POST',
      headers: {},
      body: new File(['hello'], 'hello.txt', { type: 'text/plain' }),
      signal: controller.signal,
    })

    await requestSendStarted.promise
    controller.abort(new Error('user navigated away'))
    await expect(promise).rejects.toThrow('user navigated away')

    requestEncoded.resolve()
    await vi.waitFor(() => expect(serverSignal?.aborted).toBe(true))
  })

  it('carries malicious __proto__ payloads as inert data without polluting prototypes', async () => {
    let serverBody: Record<string, unknown> | undefined

    const { client } = connect(async (request) => {
      serverBody = await request.resolveBody() as Record<string, unknown>
      return { status: 200, headers: {}, body: serverBody }
    })

    const maliciousBody = JSON.parse('{"user":"alice","__proto__":{"isAdmin":true}}')
    const response = await client.request({ url: '/login', method: 'POST', headers: {}, body: maliciousBody })
    const echoed = await response.resolveBody() as Record<string, unknown>

    expect(serverBody!.user).toBe('alice')
    expect(Object.getOwnPropertyDescriptor(serverBody, '__proto__')?.value).toEqual({ isAdmin: true })
    expect(Object.getOwnPropertyDescriptor(echoed, '__proto__')?.value).toEqual({ isAdmin: true })
    expect(({} as any).isAdmin).toBeUndefined()
    expect(Object.getPrototypeOf(serverBody)).toBe(Object.prototype)
  })
})
