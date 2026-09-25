import { AsyncIteratorClass, isAsyncIteratorObject, sleep } from '@standard-server/shared'
import { expectPeerMessages } from './client-server'
import { createExpressjsClientServerTest } from './client-server.expressjs'
import { createFastifyClientServerTest } from './client-server.fastify'
import { createHonoFetchClientServerTest } from './client-server.hono-fetch'
import { createMessagePortClientServerTest } from './client-server.message-port'
import { createNodeHttpClientServerTest } from './client-server.node-http'
import { createNodeHttp2ClientServerTest } from './client-server.node-http2'
import { createNodeHttpsClientServerTest } from './client-server.node-https'
import { createNodeWsClientServerTest } from './client-server.node-ws'

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * Only peer-based adapters propagate request body stream cancellation back to the client.
 */
const REQUEST_STREAM_CANCEL_ADAPTERS = new Set([
  'message-port',
  'message-port-fetch-streamed',
  'node-ws',
  'node-ws-fetch-streamed',
])

/**
 * Waits until `assertion` stops throwing.
 * Prefer this over a fixed `sleep` so tests continue as soon as the condition holds.
 */
function waitFor<T>(assertion: () => T): Promise<T> {
  return vi.waitFor(assertion, { timeout: 2000, interval: 10 })
}

describe.each([
  ['expressjs', () => createExpressjsClientServerTest()],
  ['expressjs-body-parser', () => createExpressjsClientServerTest({ bodyParser: true })],
  ['expressjs4', () => createExpressjsClientServerTest({ version: 4 })],
  ['expressjs4-body-parser', () => createExpressjsClientServerTest({ version: 4, bodyParser: true })],
  // ['inprogress', createInprogressClientServerTest],
  // ['inprogress-fetch', createInprogressFetchClientServerTest],
  // ['h3-node-handler', createH3NodeHandlerClientServerTest],
  // ['h3-web-handler', createH3WebHandlerClientServerTest],
  ['fastify', createFastifyClientServerTest],
  ['hono-fetch', createHonoFetchClientServerTest],
  // ['node-srvx', createNodeSrvxClientServerTest],
  // ['node-fetch-server', createNodeFetchServerClientServerTest],
  ['node-http', createNodeHttpClientServerTest],
  ['node-https', createNodeHttpsClientServerTest],
  ['node-http2', () => createNodeHttp2ClientServerTest()],
  ['node-http2-secure', () => createNodeHttp2ClientServerTest({ secure: true })],
  ['message-port', () => createMessagePortClientServerTest()],
  ['message-port-fetch-streamed', () => createMessagePortClientServerTest({ fetchStreamed: true })],
  ['node-ws', () => createNodeWsClientServerTest()],
  ['node-ws-fetch-streamed', () => createNodeWsClientServerTest({ fetchStreamed: true })],
] as const)('signal and cancel: $0', (adapter, createClientServer) => {
  const clientServer = createClientServer()

  it('never aborted', async () => {
    let serverSignal!: AbortSignal

    clientServer.handler.mockImplementationOnce(async ({ signal }) => {
      serverSignal = signal!

      await sleep(200)

      return {
        headers: {},
        status: 200,
        body: 'Hello',
      }
    })

    const response = await clientServer.request({
      headers: {},
      body: undefined,
      method: 'GET',
      url: '/',
    })

    expect(response).toMatchObject({ status: 200 })

    await sleep(100) // ensure everything is finished
    // server shouldn't abort if finished successfully
    expect(serverSignal.aborted).toBe(false)

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }],
      server: [{ kind: 'response' }],
    })
  })

  it('already aborted', async () => {
    const abortController = new AbortController()
    abortController.abort()

    await expect(clientServer.request({
      headers: {},
      body: undefined,
      method: 'GET',
      url: '/',
      signal: abortController.signal,
    })).rejects.toThrow(abortController.signal.reason)

    expectPeerMessages(clientServer, { client: [], server: [] })
  })

  it('abort while handling', async () => {
    let serverSignal!: AbortSignal

    clientServer.handler.mockImplementationOnce(async ({ signal }) => {
      serverSignal = signal!

      await sleep(1000)

      return {
        headers: {},
        status: 200,
        body: 'Hello',
      }
    })

    const abortController = new AbortController()
    const responsePromise = clientServer.request({
      headers: {},
      body: undefined,
      method: 'GET',
      url: '/',
      signal: abortController.signal,
    })

    await waitFor(() => expect(serverSignal).toBeDefined()) // wait for server start handling
    expect(serverSignal.aborted).toBe(false)

    abortController.abort()

    await waitFor(() => expect(serverSignal.aborted).toBe(true)) // wait for server receive abort signal

    await expect(responsePromise).rejects.toThrow(abortController.signal.reason)

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'cancel' }],
      server: [], // abort before send anything
    })
  })

  it('abort while sending request event stream', async () => {
    let serverSignal!: AbortSignal
    clientServer.handler.mockImplementationOnce(async ({ signal }) => {
      serverSignal = signal!
      await sleep(1000)

      return {
        headers: {},
        status: 200,
        body: 'Hello',
      }
    })

    let canceled = false
    let times = 0
    const start = Date.now()
    const abortController = new AbortController()
    const responsePromise = clientServer.request({
      headers: {},
      body: new AsyncIteratorClass(
        async () => {
          times += 1
          await sleep(times === 1 ? 25 : 1000)
          return { done: false, value: 'Hello' }
        },
        async ({ kind }) => {
          if (kind === 'cancelled') {
            canceled = true
          }
        },
      ),
      method: 'POST',
      url: '/',
      signal: abortController.signal,
    })

    // second chunk being pulled = first chunk was sent
    await waitFor(() => {
      expect(serverSignal).toBeDefined()
      expect(times).toBe(2)
    })

    expect(serverSignal.aborted).toBe(false)
    abortController.abort()

    await waitFor(() => { // wait for server receive abort signal
      expect(canceled).toBe(REQUEST_STREAM_CANCEL_ADAPTERS.has(adapter))
      expect(serverSignal.aborted).toBe(true)
    })
    expect(times).toBe(2) // the second chunk is being pulled
    expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk

    await expect(responsePromise).rejects.toThrow(abortController.signal.reason)

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'event-stream' }, { kind: 'cancel' }],
      server: [], // abort before send anything
    })
  })

  it('abort while sending request octet stream', async () => {
    let serverSignal!: AbortSignal

    clientServer.handler.mockImplementationOnce(async ({ signal }) => {
      serverSignal = signal!
      await sleep(1000)

      return {
        headers: {},
        status: 200,
        body: 'Hello',
      }
    })

    const start = Date.now()
    let cancelled = false
    let times = 0
    const abortController = new AbortController()
    const responsePromise = clientServer.request({
      headers: {},
      body: new ReadableStream({
        async pull(controller) {
          times += 1
          await sleep(times === 1 ? 25 : 1000)
          controller.enqueue(new TextEncoder().encode('Hello'))
        },
        cancel() {
          cancelled = true
        },
      }),
      method: 'POST',
      url: '/',
      signal: abortController.signal,
    })

    // second chunk being pulled = first chunk was sent
    await waitFor(() => {
      expect(serverSignal).toBeDefined()
      expect(times).toBe(2)
    })

    expect(serverSignal.aborted).toBe(false)
    abortController.abort()

    await waitFor(() => { // wait for server receive abort signal
      expect(cancelled).toBe(REQUEST_STREAM_CANCEL_ADAPTERS.has(adapter))
      expect(serverSignal.aborted).toBe(true)
    })
    expect(times).toBe(2) // the second chunk is being pulled
    expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk

    await expect(responsePromise).rejects.toThrow(abortController.signal.reason)

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'octet-stream' }, { kind: 'cancel' }],
      server: [], // abort before send anything
    })
  })

  it('abort while sending response event stream', async () => {
    let canceled = false
    let serverSignal!: AbortSignal
    let times = 0
    clientServer.handler.mockImplementationOnce(async ({ signal }) => {
      serverSignal = signal!

      return {
        headers: {},
        status: 200,
        body: new AsyncIteratorClass(
          async () => {
            times += 1
            await sleep(times === 1 ? 25 : 1000)
            return { done: false, value: 'Hello' }
          },
          async ({ kind }) => {
            if (kind === 'cancelled') {
              canceled = true
            }
          },
        ),
      }
    })

    const start = Date.now()
    const controller = new AbortController()
    const response = await clientServer.request({
      headers: {},
      body: null,
      method: 'POST',
      url: '/',
      signal: controller.signal,
    })

    const actualBody = await response.resolveBody() as AsyncGenerator
    expect(actualBody).toSatisfy(isAsyncIteratorObject)
    await actualBody.next()

    expect(serverSignal.aborted).toBe(false)
    controller.abort()

    await waitFor(() => { // wait for server receive abort signal
      expect(canceled).toBe(true)
      expect(serverSignal.aborted).toBe(true)
      expect(times).toBe(2) // the second chunk is being pulled
    })
    expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'cancel' }],
      server: [{ kind: 'response' }, { kind: 'event-stream' }],
    })
  })

  it('abort while sending response octet stream', async () => {
    let canceled = false
    let serverSignal!: AbortSignal
    let times = 0
    clientServer.handler.mockImplementationOnce(async ({ signal }) => {
      serverSignal = signal!

      return {
        headers: {},
        status: 200,
        body: new ReadableStream({
          async pull(controller) {
            times += 1
            await sleep(times === 1 ? 25 : 1000)
            controller.enqueue(new TextEncoder().encode('Hello'))
          },
          cancel() {
            canceled = true
          },
        }),
      }
    })

    const start = Date.now()
    const controller = new AbortController()
    const response = await clientServer.request({
      headers: {},
      body: null,
      method: 'POST',
      url: '/',
      signal: controller.signal,
    })

    const actualBody = await response.resolveBody() as ReadableStream
    expect(actualBody).toBeInstanceOf(ReadableStream)
    const reader = actualBody.getReader()
    await reader.read()

    expect(serverSignal.aborted).toBe(false)
    controller.abort()

    await waitFor(() => { // wait for server receive abort signal
      expect(canceled).toBe(true)
      expect(serverSignal.aborted).toBe(true)
      expect(times).toBe(2) // the second chunk is being pulled
    })
    expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'cancel' }],
      server: [{ kind: 'response' }, { kind: 'octet-stream' }],
    })
  })

  it('cancel unfinished response event stream', async () => {
    let serverSignal!: AbortSignal
    let canceled = false
    let times = 0
    clientServer.handler.mockImplementationOnce(async ({ signal }) => {
      serverSignal = signal!

      return {
        headers: {},
        status: 200,
        body: new AsyncIteratorClass(
          async () => {
            times += 1
            await sleep(times === 1 ? 25 : 1000)
            return { done: false, value: 'Hello' }
          },
          async ({ kind }) => {
            if (kind === 'cancelled') {
              canceled = true
            }
          },
        ),
      }
    })

    const start = Date.now()
    const response = await clientServer.request({
      headers: {},
      body: undefined,
      method: 'GET',
      url: '/',
    })

    const actualBody = await response.resolveBody() as AsyncGenerator
    expect(actualBody).toSatisfy(isAsyncIteratorObject)

    await actualBody.next() // wait for first chunk
    expect(serverSignal.aborted).toBe(false)

    await actualBody.return(undefined)

    await waitFor(() => { // wait for server receive cancel signal
      expect(serverSignal.aborted).toBe(true)
      expect(canceled).toBe(true)
      expect(times).toBe(2) // the second chunk is being pulled
    })
    expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'cancel' }],
      server: [{ kind: 'response' }, { kind: 'event-stream' }],
    })
  })

  it('cancel unfinished response octet stream', async () => {
    let serverSignal!: AbortSignal
    let canceled = false
    let times = 0
    clientServer.handler.mockImplementationOnce(async ({ signal }) => {
      serverSignal = signal!

      return {
        headers: {},
        status: 200,
        body: new ReadableStream({
          async pull(controller) {
            times += 1
            await sleep(times === 1 ? 25 : 1000)
            controller.enqueue(new TextEncoder().encode('Hello'))
          },
          cancel() {
            canceled = true
          },
        }),
      }
    })

    const start = Date.now()
    const response = await clientServer.request({
      headers: {},
      body: undefined,
      method: 'GET',
      url: '/',
    })

    const body = await response.resolveBody() as ReadableStream
    expect(body).toBeInstanceOf(ReadableStream)
    const reader = body.getReader()

    await reader.read() // wait for first chunk

    expect(serverSignal.aborted).toBe(false)
    await reader.cancel()

    await waitFor(() => { // wait for server receive cancel signal
      expect(serverSignal.aborted).toBe(true)
      expect(canceled).toBe(true)
      expect(times).toBe(2) // the second chunk is being pulled
    })
    expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'cancel' }],
      server: [{ kind: 'response' }, { kind: 'octet-stream' }],
    })
  })

  it('cancel unfinished request event stream', async () => {
    let serverSignal!: AbortSignal

    clientServer.handler.mockImplementationOnce(async (request) => {
      serverSignal = request.signal!

      const body = await request.resolveBody() as AsyncGenerator
      expect(body).toSatisfy(isAsyncIteratorObject)

      await body.next() // wait for first chunk
      await body.return(undefined)

      return {
        headers: {},
        status: 200,
        body: 'Hello',
      }
    })

    let canceled = false
    let times = 0
    const start = Date.now()
    const response = await clientServer.request({
      headers: {},
      body: new AsyncIteratorClass(
        async () => {
          times += 1
          await sleep(times === 1 ? 25 : 1000)
          return { done: false, value: 'Hello' }
        },
        async ({ kind }) => {
          if (kind === 'cancelled') {
            canceled = true
          }
        },
      ),
      method: 'POST',
      url: '/',
    })

    expect(response).toMatchObject({ status: 200 })

    expect(canceled).toBe(REQUEST_STREAM_CANCEL_ADAPTERS.has(adapter))
    expect(serverSignal.aborted).toBe(false) // DO NOT ABORT IF ONLY CANCEL REQUEST BODY
    expect(times).toBe(2) // the second chunk is being pulled
    expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'event-stream' }],
      server: [{ kind: 'stream/cancel' }, { kind: 'response' }],
    })
  })

  it('cancel unfinished request octet stream', async () => {
    let serverSignal!: AbortSignal

    clientServer.handler.mockImplementationOnce(async (request) => {
      serverSignal = request.signal!

      const body = await request.resolveBody() as ReadableStream
      expect(body).toBeInstanceOf(ReadableStream)

      const reader = body.getReader()
      await reader.read() // wait for first chunk
      await reader.cancel()

      return {
        headers: {},
        status: 200,
        body: 'Hello',
      }
    })

    let canceled = false
    let times = 0
    const start = Date.now()
    const response = await clientServer.request({
      headers: {},
      body: new ReadableStream({
        pull: async (controller) => {
          times += 1
          await sleep(times === 1 ? 25 : 1000)
          controller.enqueue(new TextEncoder().encode('Hello'))
        },
        cancel: async () => {
          canceled = true
        },
      }),
      method: 'POST',
      url: '/',
    })

    expect(response).toMatchObject({ status: 200 })

    expect(canceled).toBe(REQUEST_STREAM_CANCEL_ADAPTERS.has(adapter))
    expect(serverSignal.aborted).toBe(false) // DO NOT ABORT IF ONLY CANCEL REQUEST BODY
    expect(times).toBe(2) // the second chunk is being pulled
    expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'octet-stream' }],
      server: [{ kind: 'stream/cancel' }, { kind: 'response' }],
    })
  })

  it('error happen while sending request event stream', async () => {
    let serverSignal!: AbortSignal
    let serverError!: unknown
    let canceled = false

    clientServer.handler.mockImplementationOnce(async (request) => {
      serverSignal = request.signal!

      const body = await request.resolveBody() as AsyncGenerator
      expect(body).toSatisfy(isAsyncIteratorObject)

      await body.next()
      try {
        await body.next() // pull second chunk where error happen
      }
      catch (e) {
        serverError = e
      }

      return {
        headers: {},
        status: 200,
        body: 'Hello',
      }
    })

    let times = 0
    const responsePromise = clientServer.request({
      headers: {},
      body: new AsyncIteratorClass(
        async () => {
          times++

          await sleep(50)

          if (times !== 1) {
            // throw normal error not async iterator object error
            throw new Error('__TEST__')
          }

          return { done: false, value: 'Hello' }
        },
        async (completed) => {
          if (!completed) {
            canceled = true
          }
        },
      ),
      method: 'POST',
      url: '/',
    })

    await expect(responsePromise).rejects.toThrow()

    await waitFor(() => { // wait for server handle abort
      expect(serverSignal.aborted).toBe(true)
      expect(serverError).toBeInstanceOf(Error)
    })
    expect(times).toBe(2) // stop at second chunk
    expect(canceled).toBe(false) // don't need cancel if error happen

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'event-stream' }, { kind: 'cancel' }],
      server: [],
    })
  })

  it('error happen while sending request octet stream', async () => {
    let serverSignal!: AbortSignal
    let canceled = false
    let serverError!: unknown

    clientServer.handler.mockImplementationOnce(async (request) => {
      serverSignal = request.signal!

      const body = await request.resolveBody() as ReadableStream
      expect(body).toBeInstanceOf(ReadableStream)

      const reader = body.getReader()
      await reader.read()
      try {
        await reader.read() // pull second chunk where error happen
      }
      catch (e) {
        serverError = e
      }

      return {
        headers: {},
        status: 200,
        body: 'Hello',
      }
    })

    const error = new Error('__TEST__')
    let times = 0
    const responsePromise = clientServer.request({
      headers: {},
      body: new ReadableStream({
        pull: async (controller) => {
          times += 1
          await sleep(50)

          if (times !== 1) {
            controller.error(error)
          }

          controller.enqueue(new TextEncoder().encode('Hello'))
        },
        cancel: async () => {
          canceled = true
        },
      }),
      method: 'POST',
      url: '/',
    })

    if (REQUEST_STREAM_CANCEL_ADAPTERS.has(adapter)) {
      await expect(responsePromise).rejects.toThrow(error)
    }
    else {
      await expect(responsePromise).rejects.toThrow()
    }

    await waitFor(() => { // wait for server handle abort
      expect(serverSignal.aborted).toBe(true)
      expect(serverError).toBeInstanceOf(Error)
    })
    expect(times).toBe(2) // stop at second chunk
    expect(canceled).toBe(false) // don't need cancel if error happen

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'octet-stream' }, { kind: 'cancel' }],
      server: [],
    })
  })

  it('error happen while sending response event stream', async () => {
    let canceled = false
    let serverSignal!: AbortSignal
    let times = 0

    clientServer.handler.mockImplementationOnce(async (request) => {
      serverSignal = request.signal!

      return {
        headers: {},
        status: 200,
        body: new AsyncIteratorClass(
          async () => {
            times += 1
            await sleep(50)

            if (times !== 1) {
            // throw normal error not async iterator object error
              throw new Error('__TEST__')
            }

            return { done: false, value: 'Hello' }
          },
          async (completed) => {
            if (!completed) {
              canceled = true
            }
          },
        ),
      }
    })

    const response = await clientServer.request({
      headers: {},
      body: undefined,
      method: 'POST',
      url: '/',
    })

    const body = await response.resolveBody() as AsyncGenerator
    expect(body).toSatisfy(isAsyncIteratorObject)

    await body.next()
    await expect(body.next()).rejects.toBeInstanceOf(Error)

    await waitFor(() => expect(serverSignal.aborted).toBe(true)) // wait until server handled error
    expect(times).toBe(2) // stop at second chunk
    expect(canceled).toBe(false) // don't need cancel if error happen

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }],
      server: [{ kind: 'response' }, { kind: 'event-stream' }, { kind: 'cancel' }],
    })
  })

  it('error happen while sending response octet stream', async () => {
    let canceled = false
    let serverSignal!: AbortSignal
    let times = 0

    clientServer.handler.mockImplementationOnce(async (request) => {
      serverSignal = request.signal!

      return {
        headers: {},
        status: 200,
        body: new ReadableStream({
          pull: async (controller) => {
            times += 1
            await sleep(50)

            if (times === 2) {
              controller.error(new Error('__TEST__'))
            }

            controller.enqueue(new TextEncoder().encode('Hello'))
          },
          cancel: async () => {
            canceled = true
          },
        }),
      }
    })

    const response = await clientServer.request({
      headers: {},
      body: undefined,
      method: 'POST',
      url: '/',
    })

    const body = await response.resolveBody() as ReadableStream
    expect(body).toBeInstanceOf(ReadableStream)

    const reader = body.getReader()
    await reader.read()
    await expect(reader.read()).rejects.toBeInstanceOf(Error)

    await waitFor(() => expect(serverSignal.aborted).toBe(true)) // wait until server handled error
    expect(times).toBe(2) // stop at second chunk
    expect(canceled).toBe(false) // don't need cancel if error happen

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }],
      server: [{ kind: 'response' }, { kind: 'octet-stream' }, { kind: 'cancel' }],
    })
  })

  it('error happen while sending request event stream and streaming response', async () => {
    let serverSignal!: AbortSignal
    let serverError!: unknown
    let canceled = false

    clientServer.handler.mockImplementationOnce(async (request) => {
      serverSignal = request.signal!

      ;(async () => {
        const body = await request.resolveBody() as AsyncGenerator
        expect(body).toSatisfy(isAsyncIteratorObject)
        await body.next()
        try {
          await body.next() // pull second chunk where error happen
        }
        catch (e) {
          serverError = e
        }
      })()

      let time = 0
      return {
        headers: {},
        status: 200,
        body: new AsyncIteratorClass(async () => {
          time += 1
          if (time > 1) {
            await sleep(300)
          }
          return { value: 'chunk' }
        }, vi.fn()),
      }
    })

    let times = 0
    const responsePromise = clientServer.request({
      headers: {},
      body: new AsyncIteratorClass(
        async () => {
          times++

          if (times !== 1) {
            await sleep(200)
            // throw normal error not async iterator object error
            throw new Error('__TEST__')
          }

          return { done: false, value: 'Hello' }
        },
        async (completed) => {
          if (!completed) {
            canceled = true
          }
        },
      ),
      method: 'POST',
      url: '/',
    })

    const response = await responsePromise
    const iterator = await response.resolveBody() as AsyncIteratorClass<any>

    await expect(iterator.next().then(() => iterator.next())).rejects.toThrow(Error)

    await waitFor(() => { // wait for server handle abort
      expect(serverSignal.aborted).toBe(true)
      expect(serverError).toBeInstanceOf(Error)
    })
    expect(times).toBe(2) // stop at second chunk
    expect(canceled).toBe(false) // don't need cancel if error happen

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'event-stream' }, { kind: 'cancel' }],
      server: [{ kind: 'response' }, { kind: 'event-stream' }],
    })
  })

  it('error happen while sending request octet stream and streaming response', async () => {
    let serverSignal!: AbortSignal
    let serverError!: unknown
    let canceled = false

    clientServer.handler.mockImplementationOnce(async (request) => {
      serverSignal = request.signal!

      ;(async () => {
        const body = await request.resolveBody() as ReadableStream
        expect(body).toBeInstanceOf(ReadableStream)

        const reader = body.getReader()
        await reader.read()
        try {
          await reader.read() // pull second chunk where error happen
        }
        catch (e) {
          serverError = e
        }
      })()

      await sleep(100)

      return {
        headers: {},
        status: 200,
        body: new ReadableStream({
          pull: async (controller) => {
            controller.enqueue(new TextEncoder().encode('chunk\n'))
            // only wait after send first chunk, to ensure response send immediately
            await sleep(300)
          },
        }),
      }
    })

    let times = 0
    const responsePromise = clientServer.request({
      headers: {},
      body: new ReadableStream({
        pull: async (controller) => {
          times += 1

          if (times !== 1) {
            await sleep(200)
            controller.error(new Error('__TEST__'))
          }

          controller.enqueue(new TextEncoder().encode('chunk\n'))
        },
        cancel: async () => {
          canceled = true
        },
      }),
      method: 'POST',
      url: '/',
    })

    const response = await responsePromise
    const body = await response.resolveBody() as ReadableStream

    const reader = body.getReader()

    await expect(reader.read().then(() => reader.read())).rejects.toThrow(Error)

    await waitFor(() => { // wait for server handle abort
      expect(serverSignal.aborted).toBe(true)
      expect(serverError).toBeInstanceOf(Error)
    })
    expect(times).toBe(2) // stop at second chunk
    expect(canceled).toBe(false) // don't need cancel if error happen

    expectPeerMessages(clientServer, {
      client: [{ kind: 'request' }, { kind: 'octet-stream' }, { kind: 'cancel' }],
      server: [{ kind: 'response' }, { kind: 'octet-stream' }],
    })
  })
})
