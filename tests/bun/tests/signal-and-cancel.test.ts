import { afterAll, beforeEach, describe, expect, it } from 'bun:test'

import { AsyncIteratorClass, isAsyncIteratorObject, sleep } from '@standard-server/shared'

import { NOT_FOUND_HANDLER, waitFor } from './client-server'
import { createBunFetchClientServerTest } from './client-server.bun-fetch'
import { createBunWsClientServerTest } from './client-server.bun-ws'

const ADAPTERS = [
  ['bun-fetch', createBunFetchClientServerTest],
  ['bun-ws', createBunWsClientServerTest],
] as const

/**
 * Since Bun 1.4.0 both adapters propagate stream cancellation: cancelling a
 * response body closes the connection, and a streaming request body is
 * cancelled once the response has been received.
 *
 * `Bun.serve` however only aborts `request.signal` when the client goes away,
 * not when the server itself tears the connection down after its response
 * stream errors, so a response stream error only aborts the server signal for
 * the peer-based adapter, which reports it through an explicit cancel message.
 *
 * Tests assert the current Bun behavior for the other adapters, so a Bun change
 * shows up as a failure: then move the adapter into this set.
 */
const RESPONSE_STREAM_ERROR_ABORT_ADAPTERS = new Set(['bun-ws'])

for (const [adapter, createClientServer] of ADAPTERS) {
  describe(`signal and cancel: ${adapter}`, () => {
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
      // server shouldn't abort if finished successfully
      expect(serverSignal.aborted).toBe(false)
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

      expect(canceled).toBe(true)
      expect(serverSignal.aborted).toBe(false) // DO NOT ABORT IF ONLY CANCEL REQUEST BODY
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

      expect(canceled).toBe(true)
      expect(serverSignal.aborted).toBe(false) // DO NOT ABORT IF ONLY CANCEL REQUEST BODY
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

      if (RESPONSE_STREAM_ERROR_ABORT_ADAPTERS.has(adapter)) {
        await waitFor(() => expect(serverSignal.aborted).toBe(true)) // wait until server handled error
      } else {
        // the server closed the connection itself, so its own signal never aborts
        await sleep(200)
        expect(serverSignal.aborted).toBe(false)
      }

      expect(times).toBe(2) // stop at second chunk
      expect(canceled).toBe(false) // don't need cancel if error happen
    })
  })
}
