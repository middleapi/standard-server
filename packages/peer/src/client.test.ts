import type { StandardLazyResponse, StandardRequest } from '@standard-server/core'
import type { ClientPeerSendMessage, PeerCancelMessage, PeerEventStreamMessage, PeerOctetStreamMessage, PeerRequestMessage, PeerResponseMessage, PeerStreamCancelMessage } from './types'
import { AbortError, AsyncIteratorClass, isAsyncIteratorObject, promiseWithResolvers, sleep } from '@standard-server/shared'
import * as Body from './body'
import { ClientPeer } from './client'

const toStandardBodySpy = vi.spyOn(Body, 'toStandardBody')

function makeRequest(overrides: Partial<StandardRequest> = {}): StandardRequest {
  return { method: 'POST', url: '/test', headers: {}, ...overrides }
}

function makeResponseMessage(id: string, body?: unknown, headers?: Record<string, string>, status?: number): PeerResponseMessage {
  return { id, kind: 'response', json: { headers, body, status } }
}

function makeStreamingResponse(id: string, type: 'event-stream' | 'octet-stream'): PeerResponseMessage {
  return { id, kind: 'response', json: { headers: { 'standard-server': type === 'event-stream' ? 'event-stream' : undefined, 'content-type': type === 'event-stream' ? undefined : 'application/octet-stream' }, body: undefined } }
}

function makeCancelMessage(id: string): PeerCancelMessage {
  return { id, kind: 'cancel' }
}

function makeEventStreamMessage(id: string, data: unknown, event?: 'message' | 'error' | 'close'): PeerEventStreamMessage {
  return { id, kind: 'event-stream', json: { event, data } }
}

function makeOctetStreamMessage(id: string, close?: boolean, binary?: Uint8Array<ArrayBuffer>): PeerOctetStreamMessage {
  return { id, kind: 'octet-stream', json: { close }, binary }
}

function makeStreamCancelMessage(id: string): PeerStreamCancelMessage {
  return { id, kind: 'stream/cancel' }
}

function makeAsyncIter(values: unknown[]): AsyncIteratorClass<unknown> {
  let idx = 0
  return new AsyncIteratorClass<unknown>(
    async () => idx < values.length
      ? { value: values[idx++], done: false }
      : { value: undefined, done: true },
    async () => {},
  )
}

function makeHangingIter(): AsyncIteratorClass<unknown> {
  return new AsyncIteratorClass<unknown>(() => new Promise(() => {}), async () => {})
}

function getPeerSize(peer: ClientPeer): number {
  return (peer as any).requests.size
}

describe('clientPeer', () => {
  let send: ReturnType<typeof vi.fn<(msg: ClientPeerSendMessage) => Promise<void>>>
  let peer: ClientPeer

  beforeEach(() => {
    send = vi.fn<(msg: ClientPeerSendMessage) => Promise<void>>().mockResolvedValue(undefined)
    peer = new ClientPeer(send)
  })

  afterEach(() => {
    expect(getPeerSize(peer)).toBe(0)
  })

  async function waitForSend(n = 1): Promise<string> {
    await vi.waitFor(() => expect(send.mock.calls.length).toBeGreaterThanOrEqual(n))
    const requestCall = send.mock.calls.find((c: any[]) => (c[0] as any).kind === 'request')
    return (requestCall![0] as PeerRequestMessage).id
  }

  async function requestAndGetId(request?: StandardRequest): Promise<{ id: string, promise: Promise<StandardLazyResponse> }> {
    const promise = peer.request(request ?? makeRequest())
    const id = await waitForSend()
    return { id, promise }
  }

  describe('request / response', () => {
    it('sends PeerRequestMessage and resolves on PeerResponseMessage', async () => {
      const { id, promise } = await requestAndGetId(
        makeRequest({}),
      )

      expect(send).toHaveBeenCalledTimes(1)
      const sentMsg = send.mock.calls[0]![0] as PeerRequestMessage
      expect(sentMsg).toEqual({
        id,
        kind: 'request',
        json: {
          url: '/test',
        },
      })

      await peer.message(makeResponseMessage(id, undefined))
      const response = await promise
      expect(response.status).toBe(200)
      expect(response.headers).toEqual({})
      expect(await response.resolveBody()).toBe(undefined)
    })

    it('sends PeerRequestMessage and resolves on PeerResponseMessage (with full message)', async () => {
      const { id, promise } = await requestAndGetId(
        makeRequest({ method: 'DELETE', headers: { 'x-client': 'true' }, body: 'client-body' }),
      )

      expect(send).toHaveBeenCalledTimes(1)
      const sentMsg = send.mock.calls[0]![0] as PeerRequestMessage
      expect(sentMsg).toEqual({
        id,
        kind: 'request',
        json: {
          url: '/test',
          method: 'DELETE',
          headers: { 'x-client': 'true' },
          body: 'client-body',
        },
      })

      await peer.message(makeResponseMessage(id, 'server-body', { 'x-server': 'true' }, 201))
      const response = await promise
      expect(response.status).toBe(201)
      expect(response.headers).toEqual({ 'x-server': 'true' })
      expect(await response.resolveBody()).toBe('server-body')
    })

    it('ignores response for non-existing request', async () => {
      await peer.message(makeResponseMessage('nonexist'))
    })

    it('ignores duplicate response messages', async () => {
      const { id, promise } = await requestAndGetId()
      await Promise.all([
        peer.message(makeStreamingResponse(id, 'octet-stream')),
        peer.message(makeStreamingResponse(id, 'octet-stream')),
      ])

      peer.message(makeOctetStreamMessage(id, true, new Uint8Array([1, 4])))

      const response = await promise
      const body = await response.resolveBody() as ReadableStream
      expect(body).toBeInstanceOf(ReadableStream)

      const reader = body.getReader()
      expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1, 4]) })
      expect(await reader.read()).toEqual({ done: true })
    })

    it('does not rejects when parsing invalid response body until resolved', async () => {
      const { id, promise } = await requestAndGetId()

      await peer.message({
        id,
        kind: 'response',
        json: { status: 200, headers: { 'standard-server': 'form-data' }, body: undefined },
        binary: new Uint8Array([1, 2, 3]),
      })

      const response = await promise

      await expect(response.resolveBody()).rejects.toThrow()
    })

    it('resolves when the response arrives while the request message is still being sent', async () => {
      send.mockImplementation(async (message) => {
        if (message.kind === 'request') {
          // simulate a transport that delivers and processes the message before send resolves
          await peer.message(makeResponseMessage(message.id, 'early'))
        }
      })

      const response = await peer.request(makeRequest())
      expect(response.status).toBe(200)
      expect(await response.resolveBody()).toBe('early')
    })

    it('does not send the request when the peer is closed while encoding the body', async () => {
      const form = new FormData()
      form.append('note', 'hello')

      const promise = peer.request(makeRequest({ body: form }))
      const closePromise = peer.close()

      await expect(promise).rejects.toThrow(AbortError)
      await closePromise
      expect(send).not.toHaveBeenCalled()
    })

    it('rethrow and auto close if throw during toStandardBody', async () => {
      const error = new Error('something went wrong')
      toStandardBodySpy.mockImplementationOnce(() => {
        throw error
      })

      const { id, promise } = await requestAndGetId()

      await peer.message({
        id,
        kind: 'response',
        json: { status: 200, headers: { 'standard-server': 'form-data' }, body: undefined },
        binary: new Uint8Array([1, 2, 3]),
      })

      await expect(promise).rejects.toThrow(error)
      expect(getPeerSize(peer)).toEqual(0) // auto close
    })
  })

  describe('signal / abort', () => {
    it('throws immediately if signal already aborted', async () => {
      const controller = new AbortController()
      controller.abort(new Error('pre-aborted'))

      await expect(
        peer.request(makeRequest({ signal: controller.signal })),
      ).rejects.toThrow('pre-aborted')
    })

    it('sends abort message when signal aborts after request sent', async () => {
      const controller = new AbortController()
      const promise = peer.request(makeRequest({ signal: controller.signal }))

      const id = await waitForSend()
      const error = new Error('user abort')
      controller.abort(error)

      await expect(promise).rejects.toThrow(error)
      expect(send).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenNthCalledWith(2, { id, kind: 'cancel' })
    })

    it('throws when signal aborted during encode', async () => {
      const controller = new AbortController()
      const form = new FormData()
      form.append('note', 'hello')

      const promise = peer.request(makeRequest({ body: form, signal: controller.signal }))
      controller.abort(new Error('aborted during encode'))

      await expect(promise).rejects.toThrow('aborted during encode')
      // the request message is never sent, only the cancel
      expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['cancel'])
    })

    it('throws when signal aborted during send', async () => {
      const controller = new AbortController()
      send.mockImplementation(async () => {
        controller.abort(new Error('aborted during send'))
      })

      await expect(
        peer.request(makeRequest({ signal: controller.signal })),
      ).rejects.toThrow('aborted during send')

      expect(send).toHaveBeenCalledTimes(2)
      const id = (send.mock.calls[0]![0] as PeerRequestMessage).id
      expect(send).toHaveBeenNthCalledWith(2, { id, kind: 'cancel' })
    })

    it('rejects when send throws', async () => {
      const error = new Error('send failed')
      send.mockRejectedValueOnce(error)
      await expect(peer.request(makeRequest())).rejects.toThrow(error)
    })

    it('cancels an octet-stream request body when signal aborted during encode', async () => {
      const controller = new AbortController()
      const cancel = vi.fn()

      const promise = peer.request(makeRequest({ body: new ReadableStream({ cancel }), signal: controller.signal }))
      const error = new Error('aborted during encode')
      controller.abort(error)

      await expect(promise).rejects.toThrow(error)
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
      expect(cancel).toHaveBeenCalledWith(error)
      expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['cancel'])
    })

    it('returns an event-stream request body when the peer is closed while encoding', async () => {
      const cleanup = vi.fn()

      const promise = peer.request(makeRequest({ body: new AsyncIteratorClass<unknown>(() => new Promise(() => {}), cleanup) }))
      await peer.close()

      await expect(promise).rejects.toThrow(AbortError)
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
      expect(cleanup).toHaveBeenCalledWith({ kind: 'cancelled' })
      expect(send).not.toHaveBeenCalled()
    })

    it('ignores a request body that fails to clean up after the request settled', async () => {
      const controller = new AbortController()
      const cancel = vi.fn(() => {
        throw new Error('cleanup failed')
      })

      const promise = peer.request(makeRequest({ body: new ReadableStream({ cancel }), signal: controller.signal }))
      const error = new Error('aborted during encode')
      controller.abort(error)

      // the request keeps its own outcome, and the failed release is not an unhandled rejection
      await expect(promise).rejects.toBe(error)
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    })

    it('cancels the request body when send throws', async () => {
      const error = new Error('send failed')
      send.mockRejectedValueOnce(error)
      const cancel = vi.fn()

      await expect(peer.request(makeRequest({ body: new ReadableStream({ cancel }) }))).rejects.toThrow(error)
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
      expect(cancel).toHaveBeenCalledWith(error)
    })

    it('rejects pending request on server abort', async () => {
      const { id, promise } = await requestAndGetId()
      await peer.message(makeCancelMessage(id))
      await expect(promise).rejects.toThrow(AbortError)
    })

    it('removes the abort listener once the response is finished', async () => {
      const controller = new AbortController()
      const addSpy = vi.spyOn(controller.signal, 'addEventListener')
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')

      const { id, promise } = await requestAndGetId(makeRequest({ signal: controller.signal }))
      expect(addSpy).toHaveBeenCalledTimes(1)
      expect(removeSpy).not.toHaveBeenCalled()

      await peer.message(makeResponseMessage(id, 'done'))
      await promise

      // the exact listener that was added is removed again
      expect(removeSpy).toHaveBeenCalledTimes(1)
      expect(removeSpy).toHaveBeenCalledWith('abort', addSpy.mock.calls[0]![1])

      // aborting after completion is a no-op: no cancel message is sent
      controller.abort(new Error('late abort'))
      await sleep(1)
      expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['request'])
    })

    it('keeps the abort listener while the response streams and removes it when the stream finishes', async () => {
      const controller = new AbortController()
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')

      const { id, promise } = await requestAndGetId(makeRequest({ signal: controller.signal }))
      await peer.message(makeStreamingResponse(id, 'event-stream'))

      const response = await promise
      const iter = await response.resolveBody() as AsyncIterator<unknown>

      // the response is not finished yet, so aborting must still be possible
      expect(removeSpy).not.toHaveBeenCalled()

      await peer.message(makeEventStreamMessage(id, 'bye', 'close'))
      await expect(iter.next()).resolves.toEqual({ value: 'bye', done: true })

      expect(removeSpy).toHaveBeenCalledTimes(1)

      // aborting after completion is a no-op: no cancel message is sent
      controller.abort(new Error('late abort'))
      await sleep(1)
      expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['request'])
    })

    it('silently ignores transport failures when sending the cancel message on abort', async () => {
      send.mockImplementation(async (message) => {
        if (message.kind === 'cancel') {
          throw new Error('transport down')
        }
      })

      const controller = new AbortController()
      const promise = peer.request(makeRequest({ signal: controller.signal }))
      await waitForSend()

      const reason = new Error('user abort')
      controller.abort(reason)

      await expect(promise).rejects.toBe(reason)
      // let the failed cancel delivery settle; it must not surface anywhere
      await sleep(1)
    })
  })

  describe('event stream', () => {
    describe('request body (outgoing)', () => {
      it('transmits event-stream request body', async () => {
        const iter = makeAsyncIter(['a'])
        const promise = peer.request(
          makeRequest({ method: 'POST', headers: {}, body: iter }),
        )

        const id = await waitForSend()
        await vi.waitFor(() => {
          expect(send).toHaveBeenCalledTimes(3)
          expect(send).toHaveBeenNthCalledWith(1, { id, kind: 'request', binary: undefined, json: expect.objectContaining({ headers: { 'standard-server': 'event-stream' } }) })
          expect(send).toHaveBeenNthCalledWith(2, { id, kind: 'event-stream', json: { data: 'a' } })
          expect(send).toHaveBeenNthCalledWith(3, { id, kind: 'event-stream', json: { event: 'close' } })
        })

        await peer.message(makeResponseMessage(id))
        await promise
      })

      it('cancels iterator on stream/cancel message', async () => {
        const iter = makeHangingIter()
        const returnSpy = vi.spyOn(iter, 'return')

        const { id, promise } = await requestAndGetId(
          makeRequest({ method: 'POST', headers: {}, body: iter }),
        )

        await peer.message(makeStreamCancelMessage(id))
        expect(returnSpy).toHaveBeenCalled()

        await peer.message(makeResponseMessage(id))
        await promise
      })

      it('send cancel message and reject request on non-protocol error', async () => {
        const nonProtocolError = new Error('non-protocol error')
        const iter = new AsyncIteratorClass<unknown>(async () => {
          throw nonProtocolError
        }, async () => {})

        const promise = expect(
          peer.request(
            makeRequest({ method: 'POST', headers: {}, body: iter }),
          ),
        ).rejects.toBe(nonProtocolError)

        const id = await waitForSend()

        await vi.waitFor(() => {
          expect(send).toHaveBeenCalledTimes(2)
          expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'request' }))
          expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'cancel' }))
        })

        await peer.message(makeResponseMessage(id))
        await promise
      })

      it('stops transmitting the event-stream request body when a full response arrives', async () => {
        const iter = makeHangingIter()
        const returnSpy = vi.spyOn(iter, 'return')

        const { id, promise } = await requestAndGetId(
          makeRequest({ method: 'POST', headers: {}, body: iter }),
        )

        await peer.message(makeResponseMessage(id, 'done'))
        const response = await promise
        expect(await response.resolveBody()).toBe('done')

        // the server no longer reads the request body, so the upload is cancelled locally
        expect(returnSpy).toHaveBeenCalled()
        expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['request'])
      })

      it('releases the event-stream request body when the request completes during send', async () => {
        const iter = makeHangingIter()
        const returnSpy = vi.spyOn(iter, 'return')

        send.mockImplementation(async (message) => {
          if (message.kind === 'request') {
            await peer.message(makeResponseMessage(message.id, 'done'))
          }
        })

        const response = await peer.request(makeRequest({ method: 'POST', headers: {}, body: iter }))
        expect(await response.resolveBody()).toBe('done')

        // the body is released in the background, after the response already settled
        await vi.waitFor(() => expect(returnSpy).toHaveBeenCalled())
        expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['request'])
      })

      it('silently ignores transport failures when aborting after an event-stream body error', async () => {
        const iteratorError = new Error('iterator broke')
        const iter = new AsyncIteratorClass<unknown>(async () => {
          throw iteratorError
        }, async () => {})

        send.mockImplementation(async (message) => {
          if (message.kind === 'cancel') {
            throw new Error('transport down')
          }
        })

        await expect(
          peer.request(makeRequest({ method: 'POST', headers: {}, body: iter })),
        ).rejects.toBe(iteratorError)

        // let the failed cancel delivery settle; it must not surface anywhere
        await sleep(1)
      })

      it('does not send cancel message on non-protocol error if request was resolved', async () => {
        const nonProtocolError = new Error('non-protocol error')
        const { resolve: triggerError, promise: errorTrigger } = promiseWithResolvers<void>()
        const iter = new AsyncIteratorClass<unknown>(async () => {
          await errorTrigger
          throw nonProtocolError
        }, async () => {})

        const promise = peer.request(
          makeRequest({ method: 'POST', headers: {}, body: iter }),
        )

        const id = await waitForSend()
        await peer.message(makeResponseMessage(id))
        await promise

        // the iterator errors only after the request already completed
        triggerError()
        await sleep(1)

        expect(send).toHaveBeenCalledTimes(1)
        expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'request' }))
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'cancel' }))
      })
    })

    describe('response body (incoming)', () => {
      it('creates iterator from event-stream response', async () => {
        const { id, promise } = await requestAndGetId()
        await peer.message(makeStreamingResponse(id, 'event-stream'))

        const response = await promise
        const iter = await response.resolveBody() as AsyncIterator<unknown>
        expect(iter).toSatisfy(isAsyncIteratorObject)

        await peer.message(makeEventStreamMessage(id, 'evt1'))
        const result = await iter.next()
        expect(result.value).toBe('evt1')
        expect(result.done).toBe(false)

        await peer.message(makeEventStreamMessage(id, 'bye', 'close'))
        const closeResult = await iter.next()
        expect(closeResult.done).toBe(true)
      })

      it('cancel request when canceling iterator', async () => {
        const { id, promise } = await requestAndGetId()
        await peer.message(makeStreamingResponse(id, 'event-stream'))

        const response = await promise
        await peer.message(makeEventStreamMessage(id, 42))

        const iter = await response.resolveBody() as AsyncIterator<unknown>
        const result = await iter.next()
        expect(result.value).toBe(42)

        expect(send).toHaveBeenCalledTimes(1)
        expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'request' }))

        await iter.return?.()

        expect(send).toHaveBeenCalledTimes(2)
        expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'cancel' }))
      })

      it('iterator error if receive cancel message', async () => {
        const { id, promise } = await requestAndGetId()
        await peer.message(makeStreamingResponse(id, 'event-stream'))

        const response = await promise
        const iter = await response.resolveBody() as AsyncIterator<unknown>
        expect(iter).toSatisfy(isAsyncIteratorObject)

        await peer.message(makeEventStreamMessage(id, 'evt1'))
        await peer.message({ id, kind: 'cancel' })
        // ensure the previous event remains available; close, do not abort
        await expect(iter.next()).resolves.toEqual({ done: false, value: 'evt1' })
        await expect(iter.next()).rejects.toThrow('Server canceled the request')
      })
    })
  })

  describe('octet stream', () => {
    describe('request body (outgoing)', () => {
      it('transmits octet-stream request body', async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]))
            controller.close()
          },
        })

        const promise = peer.request(
          makeRequest({ method: 'POST', headers: {}, body: stream }),
        )

        const id = await waitForSend()
        await peer.message(makeResponseMessage(id))
        await promise

        expect(send).toHaveBeenCalledTimes(3)
        expect(send).toHaveBeenNthCalledWith(1, { id, kind: 'request', binary: undefined, json: expect.objectContaining({ headers: { 'content-type': 'application/octet-stream' } }) })
        expect(send).toHaveBeenNthCalledWith(2, { id, kind: 'octet-stream', json: { }, binary: new Uint8Array([1, 2]) })
        expect(send).toHaveBeenNthCalledWith(3, { id, kind: 'octet-stream', json: { close: true }, binary: undefined })
      })

      it('cancels transmitter on stream/cancel message', async () => {
        const cancel = vi.fn()
        const stream = new ReadableStream<Uint8Array>({
          start() { /* hangs */ },
          cancel,
        })

        const { id, promise } = await requestAndGetId(
          makeRequest({ method: 'POST', headers: {}, body: stream }),
        )

        await peer.message(makeStreamCancelMessage(id))
        await peer.message(makeResponseMessage(id))
        await promise

        expect(cancel).toHaveBeenCalled()
      })

      it('send cancel message and reject request on stream error', async () => {
        const error = new Error('stream error')
        const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
          async pull(controller) {
            await sleep(100)
            controller.error(error)
          },
        })

        const promise = expect(
          peer.request(
            makeRequest({ method: 'POST', headers: {}, body: stream }),
          ),
        ).rejects.toBe(error)

        const id = await waitForSend()

        await vi.waitFor(() => {
          expect(send).toHaveBeenCalledTimes(2)
          expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'request' }))
          expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'cancel' }))
        })

        await peer.message(makeResponseMessage(id))
        await promise
      })

      it('stops transmitting the octet-stream request body when a full response arrives', async () => {
        const cancel = vi.fn()
        const stream = new ReadableStream<Uint8Array>({ start() { /* hangs */ }, cancel })

        const { id, promise } = await requestAndGetId(
          makeRequest({ method: 'POST', headers: {}, body: stream }),
        )

        await peer.message(makeResponseMessage(id, 'done'))
        const response = await promise
        expect(await response.resolveBody()).toBe('done')

        // the server no longer reads the request body, so the upload is cancelled locally
        expect(cancel).toHaveBeenCalled()
        expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['request'])
      })

      it('releases the octet-stream request body when the request completes during send', async () => {
        const cancel = vi.fn()
        const stream = new ReadableStream<Uint8Array>({ start() { /* hangs */ }, cancel })

        send.mockImplementation(async (message) => {
          if (message.kind === 'request') {
            await peer.message(makeResponseMessage(message.id, 'done'))
          }
        })

        const response = await peer.request(makeRequest({ method: 'POST', headers: {}, body: stream }))
        expect(await response.resolveBody()).toBe('done')

        // the body is released in the background, after the response already settled
        await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
        expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['request'])
      })

      it('silently ignores transport failures when aborting after an octet-stream body error', async () => {
        const streamError = new Error('stream broke')
        const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
          pull(controller) {
            controller.error(streamError)
          },
        })

        send.mockImplementation(async (message) => {
          if (message.kind === 'cancel') {
            throw new Error('transport down')
          }
        })

        await expect(
          peer.request(makeRequest({ method: 'POST', headers: {}, body: stream })),
        ).rejects.toBe(streamError)

        // let the failed cancel delivery settle; it must not surface anywhere
        await sleep(1)
      })

      it('does not send cancel message on error if request was resolved', async () => {
        const error = new Error('stream error')
        const { resolve: triggerError, promise: errorTrigger } = promiseWithResolvers<void>()
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await errorTrigger
            controller.error(error)
          },
        })

        const promise = peer.request(
          makeRequest({ method: 'POST', headers: {}, body: stream }),
        )

        const id = await waitForSend()
        await peer.message(makeResponseMessage(id))
        await promise

        // the stream errors only after the request already completed
        triggerError()
        await sleep(1)

        expect(send).toHaveBeenCalledTimes(1)
        expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'cancel' }))
      })

      it('does not send cancel message when transport fails after server already canceled the upload', async () => {
        const transportError = new Error('transport failed')
        send.mockImplementation(async (message) => {
          if (message.kind === 'octet-stream') {
            // server stops consuming the upload right as the transport breaks
            await peer.message(makeStreamCancelMessage(message.id))
            throw transportError
          }
        })

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]))
          },
        })

        const { id, promise } = await requestAndGetId(
          makeRequest({ method: 'POST', headers: {}, body: stream }),
        )

        await vi.waitFor(() => expect(send.mock.calls.some(([m]) => m.kind === 'octet-stream')).toBe(true))
        await sleep(1)

        await peer.message(makeResponseMessage(id, 'ok'))
        const response = await promise
        expect(await response.resolveBody()).toBe('ok')

        expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['request', 'octet-stream'])
      })
    })

    describe('response body (incoming)', () => {
      it('creates ReadableStream from octet-stream response', async () => {
        const { id, promise } = await requestAndGetId()
        await peer.message(makeStreamingResponse(id, 'octet-stream'))

        const response = await promise
        const body = await response.resolveBody()
        expect(body).toBeInstanceOf(ReadableStream)

        const reader = (body as ReadableStream).getReader()

        await peer.message(makeOctetStreamMessage(id, false, new Uint8Array([5, 6])))
        const { value } = await reader.read()
        expect(value).toEqual(new Uint8Array([5, 6]))

        await peer.message(makeOctetStreamMessage(id, true))
        const { done } = await reader.read()
        expect(done).toBe(true)
      })

      it('cancel request when canceling ReadableStream', async () => {
        const { id, promise } = await requestAndGetId()
        await peer.message(makeStreamingResponse(id, 'octet-stream'))

        const response = await promise
        const body = await response.resolveBody()
        await peer.message(makeOctetStreamMessage(id, false, new Uint8Array([5, 6])))

        const reader = (body as ReadableStream).getReader()
        const { value } = await reader.read()
        expect(value).toEqual(new Uint8Array([5, 6]))

        expect(send).toHaveBeenCalledTimes(1)
        expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'request' }))

        await reader.cancel()

        expect(send).toHaveBeenCalledTimes(2)
        expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'cancel' }))
      })

      it('readableStream error if receive a cancel message', async () => {
        const { id, promise } = await requestAndGetId()
        await peer.message(makeStreamingResponse(id, 'octet-stream'))

        const response = await promise
        const body = await response.resolveBody()
        expect(body).toBeInstanceOf(ReadableStream)

        const reader = (body as ReadableStream).getReader()

        await peer.message(makeOctetStreamMessage(id, false, new Uint8Array([5, 6])))
        await peer.message({ id, kind: 'cancel' })

        const { value } = await reader.read()
        // ensure the previous event remains available; close, do not abort
        expect(value).toEqual(new Uint8Array([5, 6]))

        await expect(reader.read()).rejects.toThrow('Server canceled the request')
      })
    })
  })

  describe('close', () => {
    it('rejects all pending requests', async () => {
      const p1 = peer.request(makeRequest({ url: '/a' }))
      const p2 = peer.request(makeRequest({ url: '/b' }))
      await vi.waitFor(() => expect(send.mock.calls.length).toBeGreaterThanOrEqual(2))

      await peer.close()

      await expect(p1).rejects.toThrow(AbortError)
      await expect(p2).rejects.toThrow(AbortError)
    })

    it('uses custom reason when provided', async () => {
      const { promise } = await requestAndGetId()
      await peer.close(new Error('custom'))
      await expect(promise).rejects.toThrow('custom')
    })

    it('terminates active event-stream response iteration', async () => {
      const { id, promise } = await requestAndGetId()
      await peer.message(makeStreamingResponse(id, 'event-stream'))
      const response = await promise

      const iter = await response.resolveBody() as AsyncIterator<unknown>
      const nextPromise = iter.next()

      await peer.close()

      await expect(nextPromise).rejects.toThrow(AbortError)
    })

    it('terminates active octet-stream response reading', async () => {
      const { id, promise } = await requestAndGetId()
      await peer.message(makeStreamingResponse(id, 'octet-stream'))
      const response = await promise

      const reader = (await response.resolveBody() as ReadableStream).getReader()
      const readPromise = reader.read()

      await peer.close()

      await expect(readPromise).rejects.toThrow(AbortError)
    })

    it('tolerates iter.return() called after close', async () => {
      const { id, promise } = await requestAndGetId()
      await peer.message(makeStreamingResponse(id, 'event-stream'))
      const response = await promise

      const iter = await response.resolveBody() as AsyncIterator<unknown>
      await peer.close()

      // does not send abort message for already closed request
      await iter.return?.()

      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'request' }))
    })

    it('terminates ongoing event-stream request and messages', async () => {
      let cancelled = 0
      const { resolve, promise } = promiseWithResolvers<void>()
      async function* gen() {
        try {
          yield 'chunk1'
          await promise
          yield 'chunk2'
        }
        finally {
          cancelled += 1
        }
      }
      const responsePromise1 = expect(peer.request({
        url: '/',
        headers: {},
        method: 'POST',
        body: gen(),
      })).rejects.toThrow()
      const responsePromise2 = expect(peer.request({
        url: '/',
        headers: {},
        method: 'POST',
        body: gen(),
      })).rejects.toThrow()

      await sleep(1)
      expect(send).toHaveBeenCalledTimes(4)

      const closePromise = peer.close()
      resolve()
      await closePromise
      await responsePromise1
      await responsePromise2

      expect(cancelled).toBe(2)
      await sleep(10)
      expect(send).toHaveBeenCalledTimes(4) // no more messages
    })

    it('terminates ongoing octet-stream request and messages', async () => {
      let cancelled = 0
      const { resolve, promise } = promiseWithResolvers<void>()
      function gen() {
        return new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('chunk1'))
            await promise
            controller.enqueue(new TextEncoder().encode('chunk1'))
          },
          cancel() {
            cancelled += 1
          },
        })
      }

      const responsePromise1 = expect(peer.request({
        url: '/',
        headers: {},
        method: 'POST',
        body: gen(),
      })).rejects.toThrow()
      const responsePromise2 = expect(peer.request({
        url: '/',
        headers: {},
        method: 'POST',
        body: gen(),
      })).rejects.toThrow()

      await sleep(1)
      expect(send).toHaveBeenCalledTimes(4)

      const closePromise = peer.close()
      resolve()
      await closePromise
      await responsePromise1
      await responsePromise2

      expect(cancelled).toBe(2)
      await sleep(10)
      expect(send).toHaveBeenCalledTimes(4) // no more messages
    })
  })
})
