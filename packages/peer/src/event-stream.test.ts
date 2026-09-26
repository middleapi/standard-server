import type { PeerEventStreamMessage } from './types'
import { ErrorEvent, unwrapEvent, withEventMeta } from '@standard-server/core'
import { AsyncIteratorClass, Queue, sleep } from '@standard-server/shared'
import { EventStreamTransmitter, toAsyncIteratorObject } from './event-stream'

describe('toAsyncIteratorObject', () => {
  it('yields message events', async () => {
    const queue = new Queue<PeerEventStreamMessage>()
    const cleanup = vi.fn()
    const iter = toAsyncIteratorObject(queue, cleanup)

    queue.push({ id: '1', kind: 'event-stream', json: { data: 'hello1' } })
    queue.push({ id: '1', kind: 'event-stream', json: { event: 'message', data: 'hello2' } })
    queue.push({ id: '1', kind: 'event-stream', json: { event: 'close', data: undefined } })

    await expect(iter.next()).resolves.toEqual({ done: false, value: 'hello1' })
    await expect(iter.next()).resolves.toEqual({ done: false, value: 'hello2' })
    await expect(iter.next()).resolves.toEqual({ done: true, value: undefined })

    expect(cleanup).toHaveBeenCalledWith({ kind: 'success' })
  })

  it('attaches event metadata to object values', async () => {
    const queue = new Queue<PeerEventStreamMessage>()
    const cleanup = vi.fn()
    const iter = toAsyncIteratorObject(queue, cleanup)

    queue.push({
      id: '1',
      kind: 'event-stream',
      json: { data: { val: 42 }, id: 'ev-1' },
    })
    queue.push({ id: '1', kind: 'event-stream', json: { event: 'close', data: undefined } })

    const r1 = await iter.next()
    expect(r1.value).toStrictEqual({ val: 42 })
    const [data, meta] = unwrapEvent(r1.value)
    expect(data).toEqual({ val: 42 })
    expect(meta).toEqual({ id: 'ev-1' })
  })

  it('does not wrap primitive values with metadata', async () => {
    const queue = new Queue<PeerEventStreamMessage>()
    const cleanup = vi.fn()
    const iter = toAsyncIteratorObject(queue, cleanup)

    queue.push({
      id: '1',
      kind: 'event-stream',
      json: { data: 'primitive', id: 'ev-1' },
    })
    queue.push({ id: '1', kind: 'event-stream', json: { event: 'close', data: undefined } })

    const r1 = await iter.next()
    // primitives cannot be wrapped in Proxy
    expect(r1.value).toBe('primitive')
  })

  it('throws ErrorEvent on error events', async () => {
    const queue = new Queue<PeerEventStreamMessage>()
    const cleanup = vi.fn()
    const iter = toAsyncIteratorObject(queue, cleanup)

    queue.push({
      id: '1',
      kind: 'event-stream',
      json: { event: 'error', data: { code: 500 }, comments: ['oops'] },
    })

    const assertError = (err: ErrorEvent) => {
      expect(err).toBeInstanceOf(ErrorEvent)
      expect(err.data).toEqual({ code: 500 })
      const [, meta] = unwrapEvent(err)
      expect(meta).toEqual({ comments: ['oops'] })
      return true
    }

    await expect(iter.next()).rejects.toSatisfy(assertError)

    expect(cleanup).toHaveBeenCalledWith({ kind: 'error', error: expect.toSatisfy(assertError) })
  })

  it('returns done with value on close event', async () => {
    const queue = new Queue<PeerEventStreamMessage>()
    const cleanup = vi.fn()
    const iter = toAsyncIteratorObject(queue, cleanup)

    queue.push({
      id: '1',
      kind: 'event-stream',
      json: { event: 'close', data: { final: true } },
    })

    const result = await iter.next()
    expect(result.done).toBe(true)
    const [data] = unwrapEvent(result.value)
    expect(data).toEqual({ final: true })
    expect(cleanup).toHaveBeenCalledWith({ kind: 'success' })
  })

  it('calls cleanup({kind: cancelled}) when iterator.return() is called early', async () => {
    const queue = new Queue<PeerEventStreamMessage>()
    const cleanup = vi.fn()
    const iter = toAsyncIteratorObject(queue, cleanup)

    await iter.return(undefined)
    expect(cleanup).toHaveBeenCalledWith({ kind: 'cancelled' })
  })

  it('throw on aborted queue', async () => {
    const queue = new Queue<PeerEventStreamMessage>()
    const cleanup = vi.fn()
    const iter = toAsyncIteratorObject(queue, cleanup)

    const error = new Error('aborted')
    queue.abort(error)

    await expect(iter.next()).rejects.toThrow(error)
    expect(cleanup).toHaveBeenCalledWith({ kind: 'error', error })
  })

  it('rejects events carrying invalid metadata instead of forwarding them', async () => {
    const queue = new Queue<PeerEventStreamMessage>()
    const cleanup = vi.fn()
    const iter = toAsyncIteratorObject(queue, cleanup)

    // a malicious peer attempts SSE-style injection through the event id
    queue.push({ id: '1', kind: 'event-stream', json: { data: { val: 1 }, id: 'evil\nid: injected' } })

    await expect(iter.next()).rejects.toThrow()
    expect(cleanup).toHaveBeenCalledWith({ kind: 'error', error: expect.any(Error) })
  })
})

describe('eventStreamTransmitter', () => {
  it('transmits iterator items as message events', async () => {
    const send = vi.fn(async () => {})
    const items = ['a', 'b']
    let index = 0
    const iter = new AsyncIteratorClass<string>(async () => {
      if (index < items.length) {
        return { done: false, value: items[index++]! }
      }
      return { done: true, value: undefined as any }
    }, async () => {})

    const transmitter = new EventStreamTransmitter(iter, 'msg-1', send)
    await transmitter.transmit()

    expect(send).toHaveBeenCalledTimes(3) // 2 messages + close
    expect(send).toHaveBeenNthCalledWith(1, {
      id: 'msg-1',
      kind: 'event-stream',
      json: { data: 'a' },
    })
    expect(send).toHaveBeenNthCalledWith(2, {
      id: 'msg-1',
      kind: 'event-stream',
      json: { data: 'b' },
    })
    expect(send).toHaveBeenNthCalledWith(3, {
      id: 'msg-1',
      kind: 'event-stream',
      json: { event: 'close' },
    })
  })

  it('unwraps event metadata on transmission', async () => {
    const send = vi.fn(async () => {})
    const value = withEventMeta({ x: 1 }, { id: 'meta-id' })
    const iter = new AsyncIteratorClass(async () => ({ done: true, value }), async () => {})

    const transmitter = new EventStreamTransmitter(iter, 'msg-1', send)
    await transmitter.transmit()

    expect(send).toHaveBeenCalledWith({
      id: 'msg-1',
      kind: 'event-stream',
      json: { event: 'close', data: { x: 1 }, id: 'meta-id' },
    })
  })

  it('sends error event for ErrorEvent', async () => {
    const send = vi.fn(async () => {})
    const iter = new AsyncIteratorClass(async () => {
      throw new ErrorEvent({ reason: 'fail' })
    }, async () => {})

    const transmitter = new EventStreamTransmitter(iter, 'msg-1', send)
    await transmitter.transmit()

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'event-stream',
      json: expect.objectContaining({ event: 'error', data: { reason: 'fail' } }),
    }))
  })

  it('rethrows non-protocol errors', async () => {
    const send = vi.fn(async () => {})
    const iter = new AsyncIteratorClass(async () => {
      throw new Error('__TEST__')
    }, async () => {})

    const transmitter = new EventStreamTransmitter(iter, 'msg-1', send)
    await expect(transmitter.transmit()).rejects.toThrow('__TEST__')
  })

  it('rethrow send-error and cleanup during sending yield-event', async () => {
    const send = vi.fn(async () => {
      throw new Error('send failed')
    })

    const cleanup = vi.fn()
    const iter = new AsyncIteratorClass(async () => ({ done: false, value: 'data' }), cleanup)

    const transmitter = new EventStreamTransmitter(iter, 'msg-1', send)
    await expect(transmitter.transmit()).rejects.toThrow('send failed')

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith({ kind: 'cancelled' })
  })

  it('rethrow send-error and cleanup during sending return-event', async () => {
    const send = vi.fn(async () => {
      throw new Error('send failed')
    })

    const cleanup = vi.fn()
    const iter = new AsyncIteratorClass(async () => ({ done: true, value: 'data' }), cleanup)

    const transmitter = new EventStreamTransmitter(iter, 'msg-1', send)
    await expect(transmitter.transmit()).rejects.toThrow('send failed')

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith({ kind: 'success' })
  })

  it('rethrow send-error and cleanup during sending error-event', async () => {
    const send = vi.fn(async () => {
      throw new Error('send failed')
    })

    const cleanup = vi.fn()
    const iter = new AsyncIteratorClass(async () => {
      throw new ErrorEvent({ hi: true })
    }, cleanup)

    const transmitter = new EventStreamTransmitter(iter, 'msg-1', send)
    await expect(transmitter.transmit()).rejects.toThrow('send failed')

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith({ kind: 'error', error: expect.any(ErrorEvent) })
  })

  it('does not send success-event after cancel', async () => {
    const send = vi.fn(async () => {})
    const iter = new AsyncIteratorClass(async () => {
      // simulate slow iterator so cancel happens mid-stream
      await sleep(50)
      return { done: false, value: 'data' }
    }, async () => {})

    const transmitter = new EventStreamTransmitter(iter, 'msg-1', send)
    const transmitPromise = transmitter.transmit()

    // cancel immediately
    await transmitter.cancel()
    await transmitPromise

    // The first next() was already in progress when cancel was called.
    // After cancel, the transmitter should not send the result.
    expect(send).not.toHaveBeenCalled()
  })

  it('does not send error-event after cancel', async () => {
    const send = vi.fn(async () => {})
    const iter = new AsyncIteratorClass(async () => {
      // simulate slow iterator so cancel happens mid-stream
      await sleep(50)
      throw new ErrorEvent({ reason: 'fail' })
    }, async () => {})

    const transmitter = new EventStreamTransmitter(iter, 'msg-1', send)
    const transmitPromise = transmitter.transmit()

    await sleep(10)
    await transmitter.cancel()
    await transmitPromise

    // The first next() was already in progress when cancel was called.
    // After cancel, the transmitter should not send the result.
    expect(send).not.toHaveBeenCalled()
  })

  it('cancel is idempotent', async () => {
    const returnFn = vi.fn(async () => ({ done: true as const, value: undefined }))
    const iter: AsyncIterator<unknown> = {
      next: async () => ({ done: true, value: undefined }),
      return: returnFn,
    }

    const transmitter = new EventStreamTransmitter(iter, 'msg-1', vi.fn())
    await transmitter.cancel()
    await transmitter.cancel()

    expect(returnFn).toHaveBeenCalledTimes(1)
  })
})
