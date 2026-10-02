import { AsyncIteratorClass, isAsyncIteratorObject, sleep } from '@standard-server/shared'
import { expect } from '@std/expect'
import { afterAll, beforeEach, describe, it } from '@std/testing/bdd'

import { NOT_FOUND_HANDLER, waitFor } from './client-server'
import { createDenoFetchClientServerTest } from './client-server.deno-fetch'
import { createDenoWsClientServerTest } from './client-server.deno-ws'

const ADAPTERS = [
  ['deno-fetch', createDenoFetchClientServerTest],
  ['deno-ws', createDenoWsClientServerTest],
] as const

/**
 * Only peer-based adapters propagate request body stream cancellation back to the client.
 */
const REQUEST_STREAM_CANCEL_ADAPTERS = new Set(['deno-ws'])

/**
 * `Deno.serve` aborts `request.signal` once the response has been delivered,
 * even on success (legacy behavior, opt-out is still unstable), so signal
 * assertions made after the response only hold for the peer-based adapter.
 *
 * Tests assert the current (legacy) behavior for the other adapters, so a Deno
 * default change shows up as a failure: then move the adapter into this set.
 */
const CLEAN_SIGNAL_AFTER_RESPONSE_ADAPTERS = new Set(['deno-ws'])

for (const [adapter, createClientServer] of ADAPTERS) {
  describe({
    name: `signal and cancel: ${adapter}`,
    // aborted/cancelled requests legitimately leave pending timers and connections behind
    sanitizeOps: false,
    sanitizeResources: false,
    fn: () => {
      const clientServer = createClientServer()

      afterAll(() => clientServer.close())

      beforeEach(() => {
        clientServer.setHandler(NOT_FOUND_HANDLER)
      })

      it('never aborted', async () => {
        let serverSignal!: AbortSignal

        clientServer.setHandler(async ({ signal }) => {
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

        expect(response.status).toEqual(200)
        expect(await response.resolveBody()).toEqual('Hello')

        await sleep(100) // ensure everything is finished

        if (CLEAN_SIGNAL_AFTER_RESPONSE_ADAPTERS.has(adapter)) {
          // server shouldn't abort if finished successfully
          expect(serverSignal.aborted).toBe(false)
        } else {
          // legacy behavior: the signal aborts even after a successful response
          expect(serverSignal.aborted).toBe(true)
        }
      })

      it('already aborted', async () => {
        const abortController = new AbortController()
        abortController.abort()

        let handled = false
        clientServer.setHandler(async () => {
          handled = true
          return { headers: {}, status: 200, body: 'Hello' }
        })

        let error: unknown
        try {
          await clientServer.request({
            headers: {},
            body: undefined,
            method: 'GET',
            url: '/',
            signal: abortController.signal,
          })
        } catch (e) {
          error = e
        }

        expect(error).toBeDefined()
        expect(handled).toBe(false)
      })

      it('abort while handling', async () => {
        let serverSignal!: AbortSignal

        clientServer.setHandler(async ({ signal }) => {
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
        responsePromise.catch(() => {}) // avoid unhandled rejection while waiting

        await waitFor(() => expect(serverSignal).toBeDefined()) // wait for server start handling
        expect(serverSignal.aborted).toBe(false)

        abortController.abort()

        await waitFor(() => expect(serverSignal.aborted).toBe(true)) // wait for server receive abort signal

        let error: unknown
        try {
          await responsePromise
        } catch (e) {
          error = e
        }
        expect(error).toBeDefined()
      })

      it('abort while sending response event stream', async () => {
        let canceled = false
        let serverSignal!: AbortSignal
        let times = 0
        clientServer.setHandler(async ({ signal }) => {
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

        const actualBody = (await response.resolveBody()) as AsyncGenerator
        expect(isAsyncIteratorObject(actualBody)).toBe(true)
        await actualBody.next()

        expect(serverSignal.aborted).toBe(false)
        controller.abort()

        await waitFor(() => {
          // wait for server receive abort signal
          expect(canceled).toBe(true)
          expect(serverSignal.aborted).toBe(true)
          expect(times).toBe(2) // the second chunk is being pulled
        })
        expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk
      })

      it('cancel unfinished response event stream', async () => {
        let serverSignal!: AbortSignal
        let canceled = false
        let times = 0
        clientServer.setHandler(async ({ signal }) => {
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

        const actualBody = (await response.resolveBody()) as AsyncGenerator
        expect(isAsyncIteratorObject(actualBody)).toBe(true)

        await actualBody.next() // wait for first chunk
        expect(serverSignal.aborted).toBe(false)

        await actualBody.return(undefined)

        await waitFor(() => {
          // wait for server receive cancel signal
          expect(serverSignal.aborted).toBe(true)
          expect(canceled).toBe(true)
          expect(times).toBe(2) // the second chunk is being pulled
        })
        expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk
      })

      it('cancel unfinished response octet stream', async () => {
        let serverSignal!: AbortSignal
        let canceled = false
        let times = 0
        clientServer.setHandler(async ({ signal }) => {
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

        const body = (await response.resolveBody()) as ReadableStream
        expect(body).toBeInstanceOf(ReadableStream)
        const reader = body.getReader()

        await reader.read() // wait for first chunk

        expect(serverSignal.aborted).toBe(false)
        await reader.cancel()

        await waitFor(() => {
          // wait for server receive cancel signal
          expect(serverSignal.aborted).toBe(true)
          expect(canceled).toBe(true)
          expect(times).toBe(2) // the second chunk is being pulled
        })
        expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk
      })

      it('cancel unfinished request event stream', async () => {
        let serverSignal!: AbortSignal

        clientServer.setHandler(async (request) => {
          serverSignal = request.signal!

          const body = (await request.resolveBody()) as AsyncGenerator
          expect(isAsyncIteratorObject(body)).toBe(true)

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

        expect(response.status).toEqual(200)

        expect(canceled).toBe(REQUEST_STREAM_CANCEL_ADAPTERS.has(adapter))
        if (CLEAN_SIGNAL_AFTER_RESPONSE_ADAPTERS.has(adapter)) {
          expect(serverSignal.aborted).toBe(false) // DO NOT ABORT IF ONLY CANCEL REQUEST BODY
        } else {
          // legacy behavior: the signal aborts once the response has been delivered
          expect(serverSignal.aborted).toBe(true)
        }
        expect(times).toBe(2) // the second chunk is being pulled
        expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk
      })

      it('cancel unfinished request octet stream', async () => {
        let serverSignal!: AbortSignal

        clientServer.setHandler(async (request) => {
          serverSignal = request.signal!

          const body = (await request.resolveBody()) as ReadableStream
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

        expect(response.status).toEqual(200)

        expect(canceled).toBe(REQUEST_STREAM_CANCEL_ADAPTERS.has(adapter))
        if (CLEAN_SIGNAL_AFTER_RESPONSE_ADAPTERS.has(adapter)) {
          expect(serverSignal.aborted).toBe(false) // DO NOT ABORT IF ONLY CANCEL REQUEST BODY
        } else {
          // legacy behavior: the signal aborts once the response has been delivered
          expect(serverSignal.aborted).toBe(true)
        }
        expect(times).toBe(2) // the second chunk is being pulled
        expect(Date.now() - start).toBeLessThan(300) // cancelled in parallel without waiting for the second chunk
      })

      it('error happen while sending response octet stream', async () => {
        let canceled = false
        let serverSignal!: AbortSignal
        let times = 0

        clientServer.setHandler(async (request) => {
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

        const body = (await response.resolveBody()) as ReadableStream
        expect(body).toBeInstanceOf(ReadableStream)

        const reader = body.getReader()
        await reader.read()

        let error: unknown
        try {
          await reader.read()
        } catch (e) {
          error = e
        }
        expect(error).toBeDefined()

        await waitFor(() => expect(serverSignal.aborted).toBe(true)) // wait until server handled error
        expect(times).toBe(2) // stop at second chunk
        expect(canceled).toBe(false) // don't need cancel if error happen
      })
    },
  })
}
