import { Queue } from '@standard-server/shared'

import { OctetStreamTransmitter, toOctetStream } from './octet-stream'
import type { PeerOctetStreamMessage } from './types'

describe('toOctetStream', () => {
  it('enqueues binary chunks and closes', async () => {
    const queue = new Queue<PeerOctetStreamMessage>()
    const cleanup = vi.fn()
    const stream = toOctetStream(queue, cleanup)

    queue.push({
      id: '1',
      kind: 'octet-stream',
      json: {},
      binary: new Uint8Array([1, 2, 3]),
    })
    queue.push({
      id: '1',
      kind: 'octet-stream',
      json: { close: true },
      binary: new Uint8Array([4, 5]),
    })

    const reader = stream.getReader()
    const r1 = await reader.read()
    expect(r1.done).toBe(false)
    expect(r1.value).toEqual(new Uint8Array([1, 2, 3]))

    const r2 = await reader.read()
    expect(r2.done).toBe(false)
    expect(r2.value).toEqual(new Uint8Array([4, 5]))

    const r3 = await reader.read()
    expect(r3.done).toBe(true)

    expect(cleanup).toHaveBeenCalledWith({ kind: 'success' })
  })

  it('handles close with no binary', async () => {
    const queue = new Queue<PeerOctetStreamMessage>()
    const cleanup = vi.fn()
    const stream = toOctetStream(queue, cleanup)

    queue.push({
      id: '1',
      kind: 'octet-stream',
      json: { close: true },
    })

    const reader = stream.getReader()
    const r = await reader.read()
    expect(r.done).toBe(true)
    expect(cleanup).toHaveBeenCalledWith({ kind: 'success' })
  })

  it('converts Blob binary to Uint8Array', async () => {
    const queue = new Queue<PeerOctetStreamMessage>()
    const cleanup = vi.fn()
    const stream = toOctetStream(queue, cleanup)

    queue.push({
      id: '1',
      kind: 'octet-stream',
      json: {},
      binary: new Blob([new Uint8Array([10, 20])]),
    })
    queue.push({
      id: '1',
      kind: 'octet-stream',
      json: { close: true },
    })

    const reader = stream.getReader()
    const r1 = await reader.read()
    expect(r1.value).toBeInstanceOf(Uint8Array)
    expect(r1.value).toEqual(new Uint8Array([10, 20]))

    // read close
    await reader.read()
    expect(cleanup).toHaveBeenCalledWith({ kind: 'success' })
  })

  it('calls cleanup(cancelled) on cancel', async () => {
    const queue = new Queue<PeerOctetStreamMessage>()
    const cleanup = vi.fn()
    const stream = toOctetStream(queue, cleanup)

    const reader = stream.getReader()
    await reader.cancel()

    expect(cleanup).toHaveBeenCalledWith({ kind: 'cancelled' })
  })

  it('throw on aborted queue', async () => {
    const queue = new Queue<PeerOctetStreamMessage>()
    const cleanup = vi.fn()
    const stream = toOctetStream(queue, cleanup)

    const error = new Error('aborted')
    queue.abort(error)

    const reader = stream.getReader()
    await expect(reader.read()).rejects.toThrow('aborted')
    expect(cleanup).toHaveBeenCalledWith({ kind: 'error', error })
  })
})

describe('octetStreamTransmitter', () => {
  it('transmits ReadableStream chunks with close flag', async () => {
    const send = vi.fn(async () => {})
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3, 4]))
        controller.close()
      },
    })

    const transmitter = new OctetStreamTransmitter(stream, 'msg-1', send)
    await transmitter.transmit()

    expect(send).toHaveBeenCalledTimes(3) // 2 chunks + close
    expect(send).toHaveBeenNthCalledWith(1, {
      id: 'msg-1',
      kind: 'octet-stream',
      json: {},
      binary: new Uint8Array([1, 2]),
    })
    expect(send).toHaveBeenNthCalledWith(2, {
      id: 'msg-1',
      kind: 'octet-stream',
      json: {},
      binary: new Uint8Array([3, 4]),
    })
    expect(send).toHaveBeenNthCalledWith(3, {
      id: 'msg-1',
      kind: 'octet-stream',
      json: { close: true },
      binary: undefined,
    })
  })

  it('cancel stops transmission and cancels reader', async () => {
    const send = vi.fn(async () => {})
    const cancel = vi.fn()

    const stream = new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        controller.enqueue(new Uint8Array([1]))
      },
      cancel,
    })

    const transmitter = new OctetStreamTransmitter(stream, 'msg-1', send)
    const transmitPromise = transmitter.transmit()

    await transmitter.cancel()
    await transmitPromise

    expect(cancel).toHaveBeenCalledTimes(1)
    // should not have sent anything since cancel happened before first read resolved
    expect(send).not.toHaveBeenCalled()
  })

  it('rethrow stream error', async () => {
    const send = vi.fn(async () => {})
    const stream = new ReadableStream({
      async pull() {
        throw new Error('__TEST__')
      },
    })

    const transmitter = new OctetStreamTransmitter(stream, 'msg-1', send)
    await expect(transmitter.transmit()).rejects.toThrow('__TEST__')
  })

  it('rethrow send-error and cleanup during sending enqueue-event', async () => {
    const error = new Error('send failed')
    const send = vi.fn(async () => {
      throw error
    })

    const cancel = vi.fn()
    const stream = new ReadableStream({
      async pull(controller) {
        controller.enqueue(new Uint8Array([1]))
      },
      cancel,
    })

    const transmitter = new OctetStreamTransmitter(stream, 'msg-1', send)
    await expect(transmitter.transmit()).rejects.toThrow('send failed')

    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rethrow send-error during sending close-event', async () => {
    const send = vi.fn(async () => {
      throw new Error('send failed')
    })

    const cancel = vi.fn()
    const stream = new ReadableStream({
      async pull(controller) {
        controller.close()
      },
      cancel,
    })

    const transmitter = new OctetStreamTransmitter(stream, 'msg-1', send)
    await expect(transmitter.transmit()).rejects.toThrow('send failed')

    expect(cancel).toHaveBeenCalledTimes(0)
  })

  it('cancel is idempotent', async () => {
    let cancelCount = 0
    const stream = new ReadableStream({
      cancel() {
        cancelCount++
      },
    })

    const transmitter = new OctetStreamTransmitter(stream, 'msg-1', vi.fn())
    await transmitter.cancel()
    await transmitter.cancel()

    expect(cancelCount).toBe(1)
  })
})
