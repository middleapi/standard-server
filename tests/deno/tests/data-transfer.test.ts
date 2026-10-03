import type { StandardHeaders } from '@standard-server/core'
import { ErrorEvent, unwrapEvent, withEventMeta } from '@standard-server/core'
import { isAsyncIteratorObject, sleep } from '@standard-server/shared'
import { expect } from '@std/expect'
import { afterAll, beforeEach, describe, it } from '@std/testing/bdd'

import { NOT_FOUND_HANDLER } from './client-server'
import { createDenoFetchClientServerTest } from './client-server.deno-fetch'
import { createDenoWsClientServerTest } from './client-server.deno-ws'

/**
 * Streaming tests produce a chunk every `CHUNK_DELAY` ms and assert each chunk
 * arrives within `PARALLEL_THRESHOLD` ms, proving chunks are transferred in
 * parallel. Keep `PARALLEL_THRESHOLD` below `2 * CHUNK_DELAY` so a buffered
 * (non-streaming) transfer of a whole body still fails the first-chunk check.
 */
const CHUNK_DELAY = 60
const PARALLEL_THRESHOLD = 150

/**
 * Requires Deno >= 2.9.6: Deno 2.8.3 through 2.9.5 stopped delivering request
 * body chunks to a `Deno.serve` handler once it started writing a streaming
 * response (denoland/deno#36629), so echoing a transformed request stream
 * back over plain HTTP stalled after the first chunk for `deno-fetch`.
 */
const ADAPTERS = [
  ['deno-fetch', createDenoFetchClientServerTest],
  ['deno-ws', createDenoWsClientServerTest],
] as const

for (const [adapter, createClientServer] of ADAPTERS) {
  describe({
    name: `data transfer: ${adapter}`,
    // streams cancelled/aborted mid-test legitimately leave pending timers and connections behind
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
      const clientServer = createClientServer()

      afterAll(() => clientServer.close())

      beforeEach(() => {
        clientServer.setHandler(NOT_FOUND_HANDLER)
      })

      for (const [url, method, headers, status] of [
        ['/test', 'POST', {}, 200],
        ['/test?query=true', 'GET', { h1: 'v1', h2: 'v2' }, 201],
        ['/hi%2F', 'DELETE', { h3: 'v3' }, 500],
      ] as const) {
        it(`url=${url}, method=${method}, status=${status}`, async () => {
          const receivedRequests: { url: string; method: string; headers: StandardHeaders }[] = []

          clientServer.setHandler(async (request) => {
            // snapshot while handling: some runtimes release native request state once the response completes
            receivedRequests.push({
              url: request.url,
              method: request.method,
              headers: request.headers,
            })

            return {
              headers: {
                ...headers,
                'x-from': 'server',
              },
              status,
            }
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

          expect(receivedRequests.length).toEqual(1)
          const request = receivedRequests[0]!
          expect(request.url).toEqual(url)
          expect(request.method).toEqual(method)
          expect(request.headers).toMatchObject({
            ...headers,
            'x-from': 'client',
          })
        })
      }

      for (const { name, createBody, assertBody } of [
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
          assertBody: async (body: any) => {
            expect(body).toBeInstanceOf(URLSearchParams)
            expect(body.toString()).toEqual('a=b&c=d')
          },
        },
        {
          name: 'blob',
          createBody: () => new Blob(['hello world'], { type: 'text/plain' }),
          assertBody: async (body: any) => {
            expect(body).toBeInstanceOf(Blob)
            // compare against a local blob: some runtimes normalize the type (append the charset)
            expect(body.type).toEqual(new Blob([], { type: 'text/plain' }).type)
            expect(await body.text()).toEqual('hello world')
          },
        },
        {
          name: 'file',
          createBody: () => new File(['hello world'], 'test.txt', { type: 'text/plain' }),
          assertBody: async (body: any) => {
            expect(body).toBeInstanceOf(File)
            expect(body.name).toEqual('test.txt')
            // compare against a local blob: some runtimes normalize the type (append the charset)
            expect(body.type).toEqual(new Blob([], { type: 'text/plain' }).type)
            expect(await body.text()).toEqual('hello world')
          },
        },
        {
          name: 'empty-file',
          createBody: () => new File([], '', { type: '' }),
          assertBody: async (body: any) => {
            expect(body).toBeInstanceOf(File)
            expect(body.name ?? '').toEqual('')
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
            formData.append(
              'file',
              new File(['File Inside'], 'test.etc', { type: 'application/octet-stream' }),
            )
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
            return (async function* () {})()
          },
          assertBody: async (body: any) => {
            expect(isAsyncIteratorObject(body)).toBe(true)
            const iterator = body as AsyncGenerator
            expect(await iterator.next()).toEqual({ done: true, value: undefined })
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
            // Deno may surface a final empty chunk before closing, so drain and count the bytes
            let total = 0
            for (;;) {
              const { done, value } = await reader.read()
              if (done) {
                break
              }
              total += (value as Uint8Array).length
            }
            expect(total).toEqual(0)
          },
        },
      ]) {
        it(`buffered body ${name}`, async () => {
          clientServer.setHandler(async (request) => {
            if (assertBody) {
              await assertBody(await request.resolveBody())
            } else {
              expect(await request.resolveBody()).toEqual(createBody() as any)
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
          } else {
            expect(await response.resolveBody()).toEqual(createBody() as any)
          }
        })
      }

      it('event stream in parallel', async () => {
        clientServer.setHandler(async (request) => {
          const body = (await request.resolveBody()) as AsyncGenerator
          expect(isAsyncIteratorObject(body)).toBe(true)

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
          })(),
        })

        expect(response.status).toEqual(200)

        const body = (await response.resolveBody()) as AsyncGenerator
        expect(isAsyncIteratorObject(body)).toBe(true)

        const first = await body.next()
        expect(first.done).toBe(false)
        const [firstData, firstMeta] = unwrapEvent(first.value)
        expect(firstData).toEqual('order1')
        expect(firstMeta).toEqual(undefined)
        expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
        start = Date.now()

        const second = await body.next()
        expect(second.done).toBe(false)
        const [secondData, secondMeta] = unwrapEvent(second.value)
        expect(secondData).toEqual({ order: 2 })
        expect(secondMeta).toEqual({ id: 'id-2' })
        expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
        start = Date.now()

        const third = await body.next()
        expect(third.done).toBe(true)
        const [thirdData, thirdMeta] = unwrapEvent(third.value)
        expect(thirdData).toEqual({ order: 3 })
        expect(thirdMeta).toEqual({ comments: ['order3'] })
        expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
      })

      it('event stream with error event in parallel', async () => {
        clientServer.setHandler(async (request) => {
          const actualBody = (await request.resolveBody()) as AsyncGenerator
          expect(isAsyncIteratorObject(actualBody)).toBe(true)

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
          })(),
        })

        expect(response.status).toEqual(200)
        const body = (await response.resolveBody()) as AsyncGenerator
        expect(isAsyncIteratorObject(body)).toBe(true)

        const first = await body.next()
        expect(first.done).toBe(false)
        const [firstData, firstMeta] = unwrapEvent(first.value)
        expect(firstData).toEqual('order1')
        expect(firstMeta).toEqual(undefined)
        expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
        start = Date.now()

        const second = await body.next()
        expect(second.done).toBe(false)
        const [secondData, secondMeta] = unwrapEvent(second.value)
        expect(secondData).toEqual({ order: 2 })
        expect(secondMeta).toEqual({ id: 'id-2' })
        expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
        start = Date.now()

        let error: unknown
        try {
          await body.next()
        } catch (e) {
          error = e
        }

        expect(error).toBeInstanceOf(ErrorEvent)
        const [err, errMeta] = unwrapEvent(error as ErrorEvent)
        expect(err.data).toEqual({ order: 3 })
        expect(errMeta).toEqual({ comments: ['order3'] })
        expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
      })

      it('octet stream in parallel', async () => {
        clientServer.setHandler(async (request) => {
          expect(request.headers['x-from']).toEqual('client')
          expect(request.method).toEqual('POST')
          expect(request.url).toEqual('/octet-stream')

          const body = (await request.resolveBody()) as ReadableStream
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
        const body = (await response.resolveBody()) as ReadableStream
        expect(body).toBeInstanceOf(ReadableStream)
        const reader = body.getReader()

        expect(await reader.read()).toEqual({
          done: false,
          value: new TextEncoder().encode('chunk1'.repeat(10)),
        })
        expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
        start = Date.now()

        expect(await reader.read()).toEqual({
          done: false,
          value: new TextEncoder().encode('chunk2'.repeat(10)),
        })
        expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
        start = Date.now()

        expect(await reader.read()).toEqual({
          done: false,
          value: new TextEncoder().encode('chunk3'.repeat(10)),
        })
        expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
        start = Date.now()

        expect(await reader.read()).toEqual({ done: true, value: undefined })
        expect(Date.now() - start).toBeLessThan(PARALLEL_THRESHOLD)
      })
    },
  })
}
