import type { StandardLazyRequest, StandardResponse } from '@standard-server/core'
import type { PeerCancelMessage, PeerEventStreamMessage, PeerOctetStreamMessage, PeerRequestMessage, PeerResponseMessage, PeerStreamCancelMessage, ServerPeerSendMessage } from './types'
import { AbortError, AsyncIteratorClass, isAsyncIteratorObject, sleep } from '@standard-server/shared'
import { HibernationAsyncIteratorClass } from './hibernation'
import { ServerPeer } from './server'

function makeRequestMessage(overrides: Partial<PeerRequestMessage['json']> = {}, binary?: Uint8Array<ArrayBuffer>): PeerRequestMessage {
  return {
    id: '1',
    kind: 'request',
    json: { url: '/test', ...overrides },
    binary,
  }
}

function jsonResponse(body?: unknown, headers: Record<string, string> = {}, status: number = 200): StandardResponse {
  return { status, headers, body }
}

function eventStreamResponse(body: AsyncIterator<unknown> | AsyncIteratorClass<unknown>): StandardResponse {
  return { status: 200, headers: {}, body }
}

function octetStreamResponse(body: ReadableStream<Uint8Array>): StandardResponse {
  return { status: 200, headers: {}, body }
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

function makeAsyncIter(values: unknown[]): AsyncIteratorClass<unknown> {
  let idx = 0
  return new AsyncIteratorClass<unknown>(
    async () => idx < values.length
      ? { value: values[idx++], done: false }
      : { value: undefined, done: true },
    async () => {},
  )
}

function getPeerSize(peer: ServerPeer): number {
  return (peer as any).requests.size
}

describe('serverPeer', () => {
  let send: ReturnType<typeof vi.fn<(msg: ServerPeerSendMessage) => Promise<void>>>
  let peer: ServerPeer

  beforeEach(() => {
    send = vi.fn<(msg: ServerPeerSendMessage) => Promise<void>>().mockResolvedValue(undefined)
    peer = new ServerPeer(send)
  })

  afterEach(() => {
    expect(getPeerSize(peer)).toBe(0)
  })

  type HandlerFn = (req: StandardLazyRequest) => Promise<StandardResponse>

  function deferredHandler() {
    const signals: AbortSignal[] = []
    const box: { resolve: (res: StandardResponse) => void } = { resolve: undefined! }
    const handler = vi.fn<HandlerFn>().mockImplementation((req) => {
      signals.push(req.signal!)
      return new Promise<StandardResponse>(r => box.resolve = r)
    })
    return { handler, box, signals }
  }

  describe('request / response', () => {
    it('calls handler with StandardRequest and sends PeerResponseMessage', async () => {
      const handler = vi.fn<HandlerFn>().mockResolvedValue(jsonResponse())

      const message = makeRequestMessage({})
      await peer.message(message, handler)

      expect(handler).toHaveBeenCalledOnce()
      const req = handler.mock.calls[0]![0]
      expect(req.method).toBe('POST')
      expect(req.url).toBe('/test')
      expect(req.headers).toEqual({})
      expect(await req.resolveBody()).toEqual(undefined)
      expect(req.signal).toBeInstanceOf(AbortSignal)

      const sentMsg = send.mock.calls[0]![0] as PeerResponseMessage
      expect(sentMsg).toEqual({
        kind: 'response',
        id: message.id,
        json: { },
      })
    })

    it('calls handler with StandardRequest and sends PeerResponseMessage (with full messages)', async () => {
      const handler = vi.fn<HandlerFn>().mockResolvedValue(jsonResponse('response-body', { 'x-server': 'true' }, 201))

      const message = makeRequestMessage({ method: 'DELETE', url: '/test', headers: { 'x-client': 'true' }, body: 'request-body' })
      await peer.message(message, handler)

      expect(handler).toHaveBeenCalledOnce()
      const req = handler.mock.calls[0]![0]
      expect(req.method).toBe('DELETE')
      expect(req.url).toBe('/test')
      expect(req.headers).toEqual({ 'x-client': 'true' })
      expect(await req.resolveBody()).toEqual('request-body')
      expect(req.signal).toBeInstanceOf(AbortSignal)

      const sentMsg = send.mock.calls[0]![0] as PeerResponseMessage
      expect(sentMsg).toEqual({
        kind: 'response',
        id: message.id,
        json: { status: 201, headers: { 'x-server': 'true' }, body: 'response-body' },
      })
    })

    it('ignores duplicate request messages for the same id', async () => {
      const handler = vi.fn().mockResolvedValue(jsonResponse())

      await Promise.all([
        peer.message(makeRequestMessage(), handler),
        peer.message(makeRequestMessage(), handler),
      ])

      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('re-throws and sends abort when handler throws', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('handler failed'))
      await expect(peer.message(makeRequestMessage(), handler)).rejects.toThrow('handler failed')

      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'cancel' }))
    })

    it('re-throws and does not sends abort when handler throws after cancelling', async () => {
      const handler = vi.fn().mockImplementationOnce(async () => {
        await peer.message(makeCancelMessage('1'), handler)
        throw new Error('handler failed')
      })

      await expect(peer.message(makeRequestMessage(), handler)).rejects.toThrow('handler failed')

      expect(send).toHaveBeenCalledTimes(0)
    })

    it('sends abort and re-throws when send fails', async () => {
      const error = new Error('send failed')
      send.mockRejectedValueOnce(error)

      await expect(peer.message(makeRequestMessage(), async () => jsonResponse('ok'))).rejects.toThrow(error)

      expect(send).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'cancel' }))
    })
  })

  describe('signal / abort', () => {
    it('aborts signal on abort message', async () => {
      const { handler, box, signals } = deferredHandler()
      const promise = peer.message(makeRequestMessage(), handler)
      await vi.waitFor(() => expect(signals.length).toBe(1))

      await peer.message(makeCancelMessage('1'), vi.fn())

      expect(signals[0]!.aborted).toBe(true)

      box.resolve(jsonResponse())
      await promise
    })

    it('ignores abort for non-existing request', async () => {
      await peer.message(makeCancelMessage('nonexist'), vi.fn())
    })

    it('does not send response message if abort during handle request', async () => {
      const handler = vi.fn<HandlerFn>().mockImplementation(async () => {
        await peer.message(makeCancelMessage('1'), vi.fn()) // simulate aborting the request during handling
        return jsonResponse()
      })

      await peer.message(makeRequestMessage(), handler)
      expect(send).toHaveBeenCalledTimes(0)
    })

    it('does not send stream message if abort during send response message', async () => {
      send.mockImplementationOnce(async () => {
        await peer.message(makeCancelMessage('1'), vi.fn())
      })

      const handler = vi.fn<HandlerFn>().mockImplementation(async () => {
        return octetStreamResponse(new ReadableStream({ }))
      })

      await peer.message(makeRequestMessage(), handler)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'response' }))
    })
  })

  describe('event stream', () => {
    describe('request body (incoming)', () => {
      it('passes incoming event-stream chunks to the handler body as a AsyncIterator and aborts it when a response is sent before completion', async () => {
        const { handler, box } = deferredHandler()

        const msg = makeRequestMessage({ headers: { 'standard-server': 'event-stream' } })
        const promise = peer.message(msg, handler)

        await vi.waitFor(() => expect(handler).toHaveBeenCalled())
        const request = handler.mock.calls[0]![0]
        const iter = await request.resolveBody() as AsyncIterator<unknown>
        expect(iter).toSatisfy(isAsyncIteratorObject)

        await peer.message(makeEventStreamMessage('1', 'hello-data'), vi.fn())
        await expect(iter.next()).resolves.toEqual({ value: 'hello-data', done: false })

        box.resolve(jsonResponse())

        await expect(iter.next()).rejects.toThrow('Request was closed')
        await promise
      })

      it('sends stream/cancel when handler stops reading event-stream', async () => {
        let success = false

        const handler = vi.fn<HandlerFn>().mockImplementation(async (req) => {
          const iterator = await req.resolveBody() as AsyncIterator<unknown>

          await iterator.return?.()
          expect(send).toHaveBeenCalledTimes(1)
          expect(send).toHaveBeenCalledWith({ id: '1', kind: 'stream/cancel' })
          success = true

          return jsonResponse()
        })

        const msg = makeRequestMessage({ headers: { 'standard-server': 'event-stream' } })
        await peer.message(msg, handler)
        expect(success).toBeTruthy()
      })

      it('rejects a pending next() when the handler stops reading event-stream', async () => {
        const { handler, box } = deferredHandler()

        const msg = makeRequestMessage({ headers: { 'standard-server': 'event-stream' } })
        const promise = peer.message(msg, handler)

        await vi.waitFor(() => expect(handler).toHaveBeenCalled())
        const request = handler.mock.calls[0]![0]
        const iter = await request.resolveBody() as AsyncIterator<unknown>

        const pending = iter.next()
        await sleep(0) // let next() start waiting for a message
        await iter.return?.()

        await expect(pending).rejects.toBeInstanceOf(AbortError)
        await expect(iter.next()).resolves.toEqual({ value: undefined, done: true })
        expect(send).toHaveBeenCalledWith({ id: '1', kind: 'stream/cancel' })

        box.resolve(jsonResponse())
        await promise
      })

      it('asyncIterator error if receive cancel message', async () => {
        const { handler, box } = deferredHandler()

        const msg = makeRequestMessage({ headers: { 'standard-server': 'event-stream' } })
        const promise = peer.message(msg, handler)

        await vi.waitFor(() => expect(handler).toHaveBeenCalled())
        const request = handler.mock.calls[0]![0]
        const iter = await request.resolveBody() as AsyncIterator<unknown>
        expect(iter).toSatisfy(isAsyncIteratorObject)

        await peer.message(makeEventStreamMessage('1', 'hello-data'), vi.fn())
        await peer.message({ id: '1', kind: 'cancel' }, vi.fn())

        // ensure the previous event remains available; close, do not abort
        await expect(iter.next()).resolves.toEqual({ value: 'hello-data', done: false })
        await expect(iter.next()).rejects.toThrow('Client aborted the request')

        box.resolve(jsonResponse())
        await promise
      })

      it('ignores event-stream for non-existing request', async () => {
        await peer.message(makeEventStreamMessage('nonexist', 'ignored'), vi.fn())
      })

      it('stops accepting event-stream messages once the body is fully consumed', async () => {
        const { handler, box } = deferredHandler()
        const msg = makeRequestMessage({ headers: { 'standard-server': 'event-stream' } })
        const promise = peer.message(msg, handler)

        await vi.waitFor(() => expect(handler).toHaveBeenCalled())
        const request = handler.mock.calls[0]![0]
        const iter = await request.resolveBody() as AsyncIterator<unknown>

        await peer.message(makeEventStreamMessage('1', 'bye', 'close'), vi.fn())
        await expect(iter.next()).resolves.toEqual({ value: 'bye', done: true })

        // late messages are ignored instead of buffered forever
        await peer.message(makeEventStreamMessage('1', 'late'), vi.fn())
        expect((peer as any).requests.get('1').eventStreamMessageQueue).toBeUndefined()

        box.resolve(jsonResponse())
        await promise

        // the fully consumed body does not trigger a stream/cancel on close
        expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['response'])
      })
    })

    describe('response body (outgoing)', () => {
      it('transmits event-stream response body', async () => {
        const iter = makeAsyncIter(['event1', 'event2'])

        await peer.message(makeRequestMessage(), async () => eventStreamResponse(iter))

        expect(send.mock.calls.filter(([message]) => message?.kind === 'response')).toHaveLength(1)

        expect(send).toHaveBeenCalledTimes(4)
        expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'response' }))
        expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'event-stream', json: expect.objectContaining({ event: undefined, data: 'event1' }) }))
        expect(send).toHaveBeenNthCalledWith(3, expect.objectContaining({ kind: 'event-stream', json: expect.objectContaining({ event: undefined, data: 'event2' }) }))
        expect(send).toHaveBeenNthCalledWith(4, expect.objectContaining({ kind: 'event-stream', json: expect.objectContaining({ event: 'close' }) }))
      })

      it('handles HibernationAsyncIteratorClass', async () => {
        const callback = vi.fn()
        const hibernationIter = new HibernationAsyncIteratorClass(callback)

        await peer.message(
          makeRequestMessage(),
          async () => eventStreamResponse(hibernationIter),
        )

        expect(callback).toHaveBeenCalledOnce()
        expect(callback).toHaveBeenCalledWith('1')
        expect(send).toHaveBeenCalledTimes(1)
        expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'response' }))
        await expect(hibernationIter.next()).resolves.toEqual({ done: true, value: undefined }) // already cleaned up
      })

      it('reject if HibernationAsyncIteratorClassCallback reject', async () => {
        const callback = vi.fn().mockRejectedValue(new Error('callback error'))
        const hibernationIter = new HibernationAsyncIteratorClass(callback)

        await expect(peer.message(
          makeRequestMessage(),
          async () => eventStreamResponse(hibernationIter),
        )).rejects.toThrow('callback error')

        expect(callback).toHaveBeenCalledOnce()
        expect(callback).toHaveBeenCalledWith('1')
        expect(send).toHaveBeenCalledTimes(2)
        expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'response' }))
        expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'cancel' }))
        await expect(hibernationIter.next()).resolves.toEqual({ done: true, value: undefined }) // already cleaned up
      })

      it('cancels active transmitter on close', async () => {
        let resolveNext!: (v: IteratorResult<unknown>) => void
        const nextFn = vi.fn().mockImplementation(() => new Promise((r) => {
          resolveNext = r
        }))
        const returnFn = vi.fn().mockImplementation(async () => {
          resolveNext({ value: undefined, done: true })
          return { value: undefined, done: true }
        })
        const iter = new AsyncIteratorClass<unknown>(nextFn, returnFn)

        const { handler, box } = deferredHandler()
        const promise = peer.message(makeRequestMessage(), handler)
        await vi.waitFor(() => expect(handler).toHaveBeenCalled())

        box.resolve(eventStreamResponse(iter))
        await vi.waitFor(() => expect(nextFn).toHaveBeenCalled())

        await peer.close()

        expect(returnFn).toHaveBeenCalled()
        await promise
      })

      it('sends cancel message when iterator throws non-protocol error', async () => {
        const nonProtocolError = new Error('iterator error')
        const iter = new AsyncIteratorClass<unknown>(
          async () => { throw nonProtocolError },
          async () => {},
        )

        await peer.message(makeRequestMessage(), async () => eventStreamResponse(iter))

        expect(send).toHaveBeenCalledTimes(2)
        expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'response' }))
        expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'cancel' }))
      })

      it('does not send cancel message when transport fails after client already canceled the request', async () => {
        const transportError = new Error('transport failed')
        send.mockImplementation(async (message) => {
          if (message.kind === 'event-stream') {
            // client cancels the request right as the transport breaks
            await peer.message(makeCancelMessage(message.id), vi.fn())
            throw transportError
          }
        })

        await peer.message(makeRequestMessage(), async () => eventStreamResponse(makeAsyncIter(['event1'])))

        expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['response', 'event-stream'])
      })
    })
  })

  describe('octet stream', () => {
    describe('request body (incoming)', () => {
      it('passes incoming octet-stream chunks to the handler body as a ReadableStream and aborts it when a response is sent before completion', async () => {
        const { handler, box } = deferredHandler()

        const msg = makeRequestMessage({ headers: { 'standard-server': 'octet-stream', 'content-type': 'application/octet-stream' } })
        const promise = peer.message(msg, handler)

        await vi.waitFor(() => expect(handler).toHaveBeenCalled())
        const request = handler.mock.calls[0]![0]
        const body = await request.resolveBody() as ReadableStream<Uint8Array>
        expect(body).toBeInstanceOf(ReadableStream)

        await peer.message(makeOctetStreamMessage('1', undefined, new Uint8Array([1, 2, 3])), vi.fn())
        const reader = body.getReader()
        const chunk1 = await reader.read()
        expect(chunk1).toEqual({ value: new Uint8Array([1, 2, 3]), done: false })

        box.resolve(jsonResponse())

        await expect(reader.read()).rejects.toThrow('Request was closed')

        await promise
      })

      it('sends stream/cancel when handler stops reading octet-stream', async () => {
        const handler = vi.fn<HandlerFn>().mockImplementation(async (req) => {
          const body = await req.resolveBody() as ReadableStream<Uint8Array>
          await body.cancel()
          return jsonResponse()
        })

        const msg = makeRequestMessage({ headers: { 'standard-server': 'octet-stream', 'content-type': 'application/octet-stream' } })
        await peer.message(msg, handler)

        const cancelMsgs = send.mock.calls
          .map(c => c[0])
          .filter((message): message is PeerStreamCancelMessage => message?.kind === 'stream/cancel')
        expect(cancelMsgs.length).toBe(1)
        expect(cancelMsgs[0]!.id).toBe('1')
      })

      it('settles a pending read when the handler stops reading octet-stream', async () => {
        const { handler, box } = deferredHandler()

        const msg = makeRequestMessage({ headers: { 'standard-server': 'octet-stream', 'content-type': 'application/octet-stream' } })
        const promise = peer.message(msg, handler)

        await vi.waitFor(() => expect(handler).toHaveBeenCalled())
        const request = handler.mock.calls[0]![0]
        const body = await request.resolveBody() as ReadableStream<Uint8Array>
        const reader = body.getReader()

        const pending = reader.read()
        await reader.cancel()

        await expect(pending).resolves.toEqual({ value: undefined, done: true })
        expect(send).toHaveBeenCalledWith({ id: '1', kind: 'stream/cancel' })

        box.resolve(jsonResponse())
        await promise
      })

      it('readableStream error if receive cancel message', async () => {
        const { handler, box } = deferredHandler()

        const msg = makeRequestMessage({ headers: { 'standard-server': 'octet-stream', 'content-type': 'application/octet-stream' } })
        const promise = peer.message(msg, handler)

        await vi.waitFor(() => expect(handler).toHaveBeenCalled())
        const request = handler.mock.calls[0]![0]
        const body = await request.resolveBody() as ReadableStream<Uint8Array>
        expect(body).toBeInstanceOf(ReadableStream)

        await peer.message(makeOctetStreamMessage('1', undefined, new Uint8Array([1, 2, 3])), vi.fn())
        await peer.message({ id: '1', kind: 'cancel' }, vi.fn())

        const reader = body.getReader()
        const chunk1 = await reader.read()
        // ensure the previous event remains available; close, do not abort
        expect(chunk1).toEqual({ value: new Uint8Array([1, 2, 3]), done: false })
        await expect(reader.read()).rejects.toThrow('Client aborted the request')

        box.resolve(jsonResponse())
        await promise
      })

      it('ignores octet-stream for non-existing request', async () => {
        await peer.message(makeOctetStreamMessage('nonexist', undefined, new Uint8Array([1, 2, 3])), vi.fn())
      })
    })

    describe('response body (outgoing)', () => {
      it('transmits octet-stream response body', async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([10, 20]))
            controller.enqueue(new Uint8Array([30, 40]))
            controller.close()
          },
        })

        await peer.message(makeRequestMessage(), async () => octetStreamResponse(stream))

        const osMsgs = send.mock.calls
          .map(c => c[0])
          .filter((message): message is PeerOctetStreamMessage => message?.kind === 'octet-stream')
        expect(osMsgs.length).toBeGreaterThanOrEqual(2)
        expect(osMsgs[osMsgs.length - 1]!.json.close).toBe(true)
      })

      it('cancels active transmitter on close', async () => {
        const stream = new ReadableStream<Uint8Array>({ start() { /* hangs */ } })

        const { handler, box } = deferredHandler()
        const promise = peer.message(makeRequestMessage(), handler)
        await vi.waitFor(() => expect(handler).toHaveBeenCalled())

        box.resolve(octetStreamResponse(stream))
        await vi.waitFor(() => expect(getPeerSize(peer)).toBe(1))

        await peer.close()
        await promise
      })

      it('sends cancel message and when response stream errors', async () => {
        const error = new Error('stream error')
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            await sleep(0)
            controller.error(error)
          },
        })

        await peer.message(makeRequestMessage(), async () => octetStreamResponse(stream))

        expect(send).toHaveBeenCalledTimes(2)
        expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'response' }))
        expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'cancel' }))
      })

      it('does not send cancel message when transport fails after client already canceled the request', async () => {
        const transportError = new Error('transport failed')
        send.mockImplementation(async (message) => {
          if (message.kind === 'octet-stream') {
            // client cancels the request right as the transport breaks
            await peer.message(makeCancelMessage(message.id), vi.fn())
            throw transportError
          }
        })

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([10, 20]))
          },
        })

        await peer.message(makeRequestMessage(), async () => octetStreamResponse(stream))

        expect(send.mock.calls.map(([m]) => m.kind)).toEqual(['response', 'octet-stream'])
      })
    })
  })

  describe('close', () => {
    it('aborts all active requests', async () => {
      const handler1 = deferredHandler()
      const handler2 = deferredHandler()

      const p1 = peer.message(makeRequestMessage(), handler1.handler)
      const p2 = peer.message({ ...makeRequestMessage(), id: '2' }, handler2.handler)

      await vi.waitFor(() => expect(handler1.signals.length + handler2.signals.length).toBe(2))
      expect(getPeerSize(peer)).toBe(2)

      await peer.close()

      expect(handler1.signals[0]!.aborted).toBe(true)
      expect(handler2.signals[0]!.aborted).toBe(true)

      handler1.box.resolve(jsonResponse())
      handler2.box.resolve(jsonResponse())
      await p1
      await p2
    })

    it('uses custom reason when provided', async () => {
      const { handler, signals } = deferredHandler()
      peer.message(makeRequestMessage(), handler)
      await vi.waitFor(() => expect(signals.length).toBe(1))

      const customReason = new Error('custom close')
      await peer.close(customReason)

      expect(signals[0]!.reason).toBe(customReason)
    })

    it('is safe to call multiple times', async () => {
      await peer.close()
      await peer.close()
    })

    it('closes event-stream message queues', async () => {
      const { handler, box } = deferredHandler()
      const msg = makeRequestMessage({ headers: { 'standard-server': 'event-stream' } })
      const promise = peer.message(msg, handler)
      await vi.waitFor(() => expect(handler).toHaveBeenCalled())

      const request = handler.mock.calls[0]![0]
      const iter = await request.resolveBody() as AsyncIterator<unknown>
      expect(iter).toSatisfy(isAsyncIteratorObject)
      const readPromise = expect(iter.next()).rejects.toThrow(AbortError)

      await peer.close()

      box.resolve(jsonResponse())
      await readPromise
      await promise
    })

    it('closes octet-stream message queues', async () => {
      const { handler, box } = deferredHandler()
      const msg = makeRequestMessage({ headers: { 'standard-server': 'octet-stream', 'content-type': 'application/octet-stream' } })
      const promise = peer.message(msg, handler)
      await vi.waitFor(() => expect(handler).toHaveBeenCalled())
      const request = handler.mock.calls[0]![0]
      const body = await request.resolveBody() as ReadableStream<Uint8Array>
      expect(body).toBeInstanceOf(ReadableStream)
      const reader = body.getReader()
      const readPromise = expect(reader.read()).rejects.toThrow(AbortError)

      await peer.close()

      box.resolve(jsonResponse())
      await promise
      await readPromise
    })
  })
})
