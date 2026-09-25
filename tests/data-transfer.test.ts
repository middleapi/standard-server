import { ErrorEvent, unwrapEvent, withEventMeta } from '@standard-server/core'
import { isAsyncIteratorObject, sleep } from '@standard-server/shared'
import { expectPeerMessages } from './client-server'
import { createExpressjsClientServerTest } from './client-server.expressjs'
import { createFastifyClientServerTest } from './client-server.fastify'
import { createH3WebHandlerClientServerTest } from './client-server.h3-web-handler'
import { createHonoFetchClientServerTest } from './client-server.hono-fetch'
import { createInprogressClientServerTest } from './client-server.inprogress'
import { createInprogressFetchClientServerTest } from './client-server.inprogress-fetch'
import { createMessagePortClientServerTest } from './client-server.message-port'
import { createNodeHttpClientServerTest } from './client-server.node-http'
import { createNodeHttp2ClientServerTest } from './client-server.node-http2'
import { createNodeHttpsClientServerTest } from './client-server.node-https'
import { createNodeSrvxClientServerTest } from './client-server.node-srvx'
import { createNodeWsClientServerTest } from './client-server.node-ws'

/**
 * Streaming tests produce a chunk every `CHUNK_DELAY` ms and assert each chunk
 * arrives within `PARALLEL_THRESHOLD` ms, proving chunks are transferred in
 * parallel. Keep `PARALLEL_THRESHOLD` below `2 * CHUNK_DELAY` so a buffered
 * (non-streaming) transfer of a whole body still fails the first-chunk check.
 */
const CHUNK_DELAY = 60
const PARALLEL_THRESHOLD = 150

describe.each([
  ['expressjs', () => createExpressjsClientServerTest()],
  ['expressjs-body-parser', () => createExpressjsClientServerTest({ bodyParser: true })],
  ['expressjs4', () => createExpressjsClientServerTest({ version: 4 })],
  ['expressjs4-body-parser', () => createExpressjsClientServerTest({ version: 4, bodyParser: true })],
  ['inprogress', createInprogressClientServerTest],
  ['inprogress-fetch', createInprogressFetchClientServerTest],
  // ['h3-node-handler', createH3NodeHandlerClientServerTest],
  ['h3-web-handler', createH3WebHandlerClientServerTest],
  ['fastify', createFastifyClientServerTest],
  ['hono-fetch', createHonoFetchClientServerTest],
  ['node-srvx', createNodeSrvxClientServerTest],
  // ['node-fetch-server', createNodeFetchServerClientServerTest],
  ['node-http', createNodeHttpClientServerTest],
  ['node-https', createNodeHttpsClientServerTest],
  ['node-http2', () => createNodeHttp2ClientServerTest()],
  ['node-http2-secure', () => createNodeHttp2ClientServerTest({ secure: true })],
  ['message-port', () => createMessagePortClientServerTest()],
  ['message-port-fetch-streamed', () => createMessagePortClientServerTest({ fetchStreamed: true })],
  ['node-ws', () => createNodeWsClientServerTest()],
  ['node-ws-fetch-streamed', () => createNodeWsClientServerTest({ fetchStreamed: true })],
])('data transfer: $0', (_, createClientServer) => {
  const clientServer = createClientServer()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['/test', 'POST', {}, 200],
    ['/test?query=true', 'GET', { h1: 'v1', h2: 'v2' }, 201],
    ['/hi%2F', 'DELETE', { h3: 'v3' }, 500],
  ])('url=$0, method=$1, headers=$2, status=$3', async (url, method, headers, status) => {
    clientServer.handler.mockResolvedValueOnce({
      headers: {
        ...headers,
        'x-from': 'server',
      },
      status,
    })

    const response = await clientServer.request({
      headers: {
        ...headers,
        'x-from': 'client',
      },
      method,
      url: url as any,
    })

    expect(response.headers).toMatchObject({
      ...headers,
      'x-from': 'server',
    })
    expect(response.status).toEqual(status)

    expect(clientServer.handler).toHaveBeenCalledTimes(1)
    const request = clientServer.handler.mock.calls[0]![0]
    expect(request.url).toEqual(url)
    expect(request.method).toEqual(method)
    expect(request.headers).toMatchObject({
      ...headers,
      'x-from': 'client',
    })
  })

  it.each([
    {
      name: 'undefined',
      createBody: () => undefined,
    },
    {
      name: 'json-string',
      createBody: () => 'string',
    },
    {
      name: 'json-object',
      createBody: () => ({ a: 1, b: [2, 3, { c: 4 }] }),
    },
    {
      name: 'URLSearchParams',
      createBody: () => new URLSearchParams('a=b&c=d'),
    },
    {
      name: 'blob',
      createBody: () => new Blob(['hello world'], { type: 'text/plain' }),
      assertBody: async (body: any) => {
        expect(body).toBeInstanceOf(Blob)
        expect(body.type).toEqual('text/plain')
        expect(await body.text()).toEqual('hello world')
      },
    },
    {
      name: 'file',
      createBody: () => new File(['hello world'], 'test.txt', { type: 'text/plain' }),
      assertBody: async (body: any) => {
        expect(body).toBeInstanceOf(File)
        expect(body.name).toEqual('test.txt')
        expect(body.type).toEqual('text/plain')
        expect(await body.text()).toEqual('hello world')
      },
    },
    {
      name: 'empty-file',
      createBody: () => new File([], '', { type: '' }),
      assertBody: async (body: any) => {
        expect(body).toBeInstanceOf(File)
        expect(body.name).toEqual('')
        expect(body.type).toEqual('')
        expect(body.size).toEqual(0)
        expect(await body.text()).toEqual('')
      },
    },
    {
      name: 'formdata',
      createBody: () => {
        const formData = new FormData()
        formData.append('a', 'b')
        formData.append('c', 'd')
        formData.append('file', new File(['File Inside'], 'test.etc', { type: 'application/octet-stream' }))
        return formData
      },
      assertBody: async (body: any) => {
        expect(body).toBeInstanceOf(FormData)
        const form = body as FormData
        expect([...form.keys()]).toEqual(['a', 'c', 'file'])
        expect(form.getAll('a')).toEqual(['b'])
        expect(form.getAll('c')).toEqual(['d'])

        const files = form.getAll('file')
        expect(files.length).toEqual(1)
        const file = files[0] as File
        expect(file.name).toEqual('test.etc')
        expect(file.type).toEqual('application/octet-stream')
        expect(await file.text()).toEqual('File Inside')
      },
    },
    {
      name: 'empty-event-stream',
      createBody: () => {
        return (async function* () {}())
      },
      assertBody: async (body: any) => {
        expect(body).toSatisfy(isAsyncIteratorObject)
        const iterator = body as AsyncGenerator
        await expect(iterator.next()).resolves.toEqual({ done: true })
      },
    },
    {
      name: 'empty-octet-stream',
      createBody: () => {
        return new ReadableStream({
          start(controller) {
            controller.close()
          },
        })
      },
      assertBody: async (body: any) => {
        expect(body).toBeInstanceOf(ReadableStream)
        const stream = body as ReadableStream
        const reader = stream.getReader()
        await expect(reader.read()).resolves.toEqual({ done: true })
      },
    },
  ])('buffered body $name', async ({ createBody, assertBody }) => {
    clientServer.handler.mockImplementationOnce(async (request) => {
      if (assertBody) {
        await assertBody(await request.resolveBody())
      }
      else {
        expect(await request.resolveBody()).toEqual(createBody())
      }

      return {
        headers: {},
        status: 200,
        body: createBody(),
      }
    })

    const response = await clientServer.request({
      headers: {
        'x-from': 'client',
      },
      method: 'POST',
      url: '/test',
      body: createBody(),
    })

    expect(response.status).toEqual(200)

    if (assertBody) {
      await assertBody(await response.resolveBody())
    }
    else {
      expect(await response.resolveBody()).toEqual(createBody())
    }
  })

  it('event stream in parallel', async () => {
    clientServer.handler.mockImplementationOnce(async (request) => {
      const body = await request.resolveBody() as AsyncGenerator
      expect(body).toSatisfy(isAsyncIteratorObject)

      return {
        headers: {},
        status: 200,
        body,
      }
    })

    let start = Date.now()
    const response = await clientServer.request({
      headers: {
        'x-from': 'client',
      },
      method: 'DELETE',
      url: '/event-stream',
      body: (async function* () {
        await sleep(CHUNK_DELAY)
        yield 'order1'
        await sleep(CHUNK_DELAY)
        yield withEventMeta({ order: 2 }, { id: 'id-2' })
        await sleep(CHUNK_DELAY)
        return withEventMeta({ order: 3 }, { comments: ['order3'] })
      }()),
    })

    expect(response.status).toEqual(200)

    const body = await response.resolveBody() as AsyncGenerator
    expect(body).toSatisfy(isAsyncIteratorObject)

    await expect(body.next()).resolves.toSatisfy((result) => {
      expect(result.done).toBe(false)
      const [data, meta] = unwrapEvent(result.value)
      expect(data).toEqual('order1')
      expect(meta).toEqual(undefined)
      return true
    })
    expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
    start = Date.now()

    await expect(body.next()).resolves.toSatisfy((result) => {
      expect(result.done).toBe(false)
      const [data, meta] = unwrapEvent(result.value)
      expect(data).toEqual({ order: 2 })
      expect(meta).toEqual({ id: 'id-2' })
      return true
    })
    expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
    start = Date.now()

    await expect(body.next()).resolves.toSatisfy((result) => {
      expect(result.done).toBe(true)
      const [data, meta] = unwrapEvent(result.value)
      expect(data).toEqual({ order: 3 })
      expect(meta).toEqual({ comments: ['order3'] })
      return true
    })
    expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)

    expectPeerMessages(clientServer, {
      client: [
        { kind: 'request' },
        { kind: 'event-stream', json: expect.objectContaining({ event: undefined }) },
        { kind: 'event-stream', json: expect.objectContaining({ event: undefined }) },
        { kind: 'event-stream', json: expect.objectContaining({ event: 'close' }) },
      ],
      server: [
        { kind: 'response' },
        { kind: 'event-stream', json: expect.objectContaining({ event: undefined }) },
        { kind: 'event-stream', json: expect.objectContaining({ event: undefined }) },
        { kind: 'event-stream', json: expect.objectContaining({ event: 'close' }) },
      ],
    })
  })

  it('event stream with error event in parallel', async () => {
    clientServer.handler.mockImplementationOnce(async (request) => {
      const actualBody = await request.resolveBody() as AsyncGenerator
      expect(actualBody).toSatisfy(isAsyncIteratorObject)

      return {
        headers: {},
        status: 200,
        body: actualBody,
      }
    })

    let start = Date.now()
    const response = await clientServer.request({
      headers: {
        'x-from': 'client',
      },
      method: 'DELETE',
      url: '/event-stream',
      body: (async function* () {
        await sleep(CHUNK_DELAY)
        yield 'order1'
        await sleep(CHUNK_DELAY)
        yield withEventMeta({ order: 2 }, { id: 'id-2' })
        throw withEventMeta(new ErrorEvent({ order: 3 }), { comments: ['order3'] })
      }()),
    })

    expect(response.status).toEqual(200)
    const body = await response.resolveBody() as AsyncGenerator
    expect(body).toSatisfy(isAsyncIteratorObject)

    await expect(body.next()).resolves.toSatisfy((result) => {
      expect(result.done).toBe(false)
      const [data, meta] = unwrapEvent(result.value)
      expect(data).toEqual('order1')
      expect(meta).toEqual(undefined)
      return true
    })
    expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
    start = Date.now()

    await expect(body.next()).resolves.toSatisfy((result) => {
      expect(result.done).toBe(false)
      const [data, meta] = unwrapEvent(result.value)
      expect(data).toEqual({ order: 2 })
      expect(meta).toEqual({ id: 'id-2' })
      return true
    })
    expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
    start = Date.now()

    await expect(body.next()).rejects.toSatisfy((error: ErrorEvent) => {
      expect(error).toBeInstanceOf(ErrorEvent)
      const [err, errMeta] = unwrapEvent(error)
      expect(err.data).toEqual({ order: 3 })
      expect(errMeta).toEqual({ comments: ['order3'] })
      return true
    })
    expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
    start = Date.now()

    expectPeerMessages(clientServer, {
      client: [
        { kind: 'request' },
        { kind: 'event-stream', json: expect.objectContaining({ event: undefined }) },
        { kind: 'event-stream', json: expect.objectContaining({ event: undefined }) },
        { kind: 'event-stream', json: expect.objectContaining({ event: 'error' }) },
      ],
      server: [
        { kind: 'response' },
        { kind: 'event-stream', json: expect.objectContaining({ event: undefined }) },
        { kind: 'event-stream', json: expect.objectContaining({ event: undefined }) },
        { kind: 'event-stream', json: expect.objectContaining({ event: 'error' }) },
      ],
    })
  })

  it('octet stream in parallel', async () => {
    clientServer.handler.mockImplementationOnce(async (request) => {
      expect(request.headers['x-from']).toEqual('client')
      expect(request.method).toEqual('POST')
      expect(request.url).toEqual('/octet-stream')

      const body = await request.resolveBody() as ReadableStream
      expect(body).toBeInstanceOf(ReadableStream)

      return {
        headers: {
          'x-from': 'server',
        },
        status: 200,
        body,
      }
    })

    let start = Date.now()
    const response = await clientServer.request({
      headers: {
        'x-from': 'client',
      },
      method: 'POST',
      url: '/octet-stream',
      body: new ReadableStream({
        async start(controller) {
          // make sure each chunk is long enough to ensure client/server transfer separately
          await sleep(CHUNK_DELAY)
          controller.enqueue(new TextEncoder().encode('chunk1'.repeat(10)))
          await sleep(CHUNK_DELAY)
          controller.enqueue(new TextEncoder().encode('chunk2'.repeat(10)))
          await sleep(CHUNK_DELAY)
          controller.enqueue(new TextEncoder().encode('chunk3'.repeat(10)))
          await sleep(CHUNK_DELAY)
          controller.close()
        },
      }),
    })

    expect(response.headers['x-from']).toEqual('server')
    expect(response.status).toEqual(200)
    const body = await response.resolveBody() as ReadableStream
    expect(body).toBeInstanceOf(ReadableStream)
    const reader = body.getReader()

    await expect(reader.read()).resolves.toEqual({ done: false, value: new TextEncoder().encode('chunk1'.repeat(10)) })
    expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
    start = Date.now()

    await expect(reader.read()).resolves.toEqual({ done: false, value: new TextEncoder().encode('chunk2'.repeat(10)) })
    expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
    start = Date.now()

    await expect(reader.read()).resolves.toEqual({ done: false, value: new TextEncoder().encode('chunk3'.repeat(10)) })
    expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
    start = Date.now()

    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)

    expectPeerMessages(clientServer, {
      client: [
        { kind: 'request' },
        { kind: 'octet-stream' },
        { kind: 'octet-stream' },
        { kind: 'octet-stream' },
        { kind: 'octet-stream', json: expect.objectContaining({ close: true }) },
      ],
      server: [
        { kind: 'response' },
        { kind: 'octet-stream' },
        { kind: 'octet-stream' },
        { kind: 'octet-stream' },
        { kind: 'octet-stream', json: expect.objectContaining({ close: true }) },
      ],
    })
  })
})
