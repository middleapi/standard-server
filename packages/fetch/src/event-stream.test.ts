import { ErrorEvent, getEventMeta, withEventMeta } from '@standard-server/core'
import { isAsyncIteratorObject, sleep } from '@standard-server/shared'
import { toAsyncIteratorObject, toEventStream } from './event-stream'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0) // ensure no timers are left hanging
  vi.useRealTimers()
})

describe('toAsyncIteratorObject', () => {
  it('with close event', async () => {
    const stream = new ReadableStream<string>({
      async pull(controller) {
        controller.enqueue('event: message\ndata: {"order": 1}\nid: id-1\nretry: 10000\n\n')
        controller.enqueue('event: message\ndata: {"order": 2}\nid: id-2\n\n')
        controller.enqueue(': ping\n\n')
        controller.enqueue('event: close\ndata: {"order": 3}\nid: id-3\nretry: 30000\n\n')
        controller.close()
      },
    }).pipeThrough(new TextEncoderStream())

    const generator = toAsyncIteratorObject(stream)
    expect(generator).toSatisfy(isAsyncIteratorObject)

    expect(await generator.next()).toSatisfy(({ done, value }) => {
      expect(done).toEqual(false)
      expect(value).toStrictEqual({ order: 1 })
      expect(getEventMeta(value)).toEqual({ id: 'id-1', retry: 10000 })

      return true
    })

    expect(await generator.next()).toSatisfy(({ done, value }) => {
      expect(done).toEqual(false)
      expect(value).toStrictEqual({ order: 2 })
      expect(getEventMeta(value)).toEqual({ id: 'id-2' })

      return true
    })

    expect(await generator.next()).toSatisfy(({ done, value }) => {
      expect(done).toEqual(true)
      expect(value).toStrictEqual({ order: 3 })
      expect(getEventMeta(value)).toEqual({ id: 'id-3', retry: 30000 })

      return true
    })
  })

  it('without close event', async () => {
    const stream = new ReadableStream<string>({
      async pull(controller) {
        controller.enqueue(': ping\n\n')
        controller.enqueue('event: message\ndata: {"order": 1}\nid: id-1\nretry: 10000\n\n')
        controller.enqueue('event: message\ndata: {"order": 2}\nid: id-2\n\n')
        controller.close()
      },
    }).pipeThrough(new TextEncoderStream())

    const generator = toAsyncIteratorObject(stream)
    expect(generator).toSatisfy(isAsyncIteratorObject)

    expect(await generator.next()).toSatisfy(({ done, value }) => {
      expect(done).toEqual(false)
      expect(value).toEqual({ order: 1 })
      expect(getEventMeta(value)).toEqual({ id: 'id-1', retry: 10000 })

      return true
    })

    expect(await generator.next()).toSatisfy(({ done, value }) => {
      expect(done).toEqual(false)
      expect(value).toEqual({ order: 2 })
      expect(getEventMeta(value)).toEqual({ id: 'id-2' })

      return true
    })

    expect(await generator.next()).toSatisfy(({ done, value }) => {
      expect(done).toEqual(true)
      expect(value).toEqual(undefined)
      expect(getEventMeta(value)).toEqual(undefined)

      return true
    })

    await expect(stream.getReader().closed).resolves.toBe(undefined)
  })

  it('with extra blank lines', async () => {
    const stream = new ReadableStream<string>({
      async pull(controller) {
        controller.enqueue('\n: ping\n\n\n')
        controller.enqueue('event: message\ndata: {"order": 1}\n\n\n')
        controller.enqueue('\r\n: ping\r\n\r\n\r\n')
        controller.enqueue('event: message\ndata: {"order": 2}\n\n\n')
        controller.close()
      },
    }).pipeThrough(new TextEncoderStream())

    const generator = toAsyncIteratorObject(stream)

    expect(await generator.next()).toEqual({ done: false, value: { order: 1 } })
    expect(await generator.next()).toEqual({ done: false, value: { order: 2 } })
    expect(await generator.next()).toEqual({ done: true, value: undefined })
  })

  it('with empty stream', async () => {
    const generator = toAsyncIteratorObject(null)
    expect(generator).toSatisfy(isAsyncIteratorObject)
    expect(await generator.next()).toEqual({ done: true })
    expect(await generator.next()).toEqual({ done: true })
  })

  it.skipIf(process.version.startsWith('v26.'))('with error event', async () => {
    const stream = new ReadableStream<string>({
      async pull(controller) {
        controller.enqueue('event: message\ndata: {"order": 1}\nid: id-1\nretry: 10000\n\n')
        controller.enqueue('event: message\ndata: {"order": 2}\nid: id-2\n\n')
        controller.enqueue('event: error\ndata: {"order": 3}\nid: id-3\nretry: 30000\n\n')
        controller.enqueue(': ping\n\n')
        controller.close()
      },
    }).pipeThrough(new TextEncoderStream())

    const generator = toAsyncIteratorObject(stream)
    expect(generator).toSatisfy(isAsyncIteratorObject)

    expect(await generator.next()).toSatisfy(({ done, value }) => {
      expect(done).toEqual(false)
      expect(value).toEqual({ order: 1 })
      expect(getEventMeta(value)).toEqual({ id: 'id-1', retry: 10000 })

      return true
    })

    expect(await generator.next()).toSatisfy(({ done, value }) => {
      expect(done).toEqual(false)
      expect(value).toEqual({ order: 2 })
      expect(getEventMeta(value)).toEqual({ id: 'id-2' })

      return true
    })

    await expect(generator.next()).rejects.toSatisfy((error: any) => {
      expect(error).toBeInstanceOf(ErrorEvent)
      expect(error.data).toEqual({ order: 3 })
      expect(getEventMeta(error)).toEqual({ id: 'id-3', retry: 30000 })

      return true
    })

    await expect(stream.getReader().closed).resolves.toBe(undefined)
  })

  it('when .return() before finish reading', async () => {
    const stream = new ReadableStream<string>({
      async pull(controller) {
        controller.enqueue('event: message\ndata: {"order": 1}\nid: id-1\nretry: 10000\n\n')
        await new Promise(resolve => setTimeout(resolve, 25))
        controller.close()
      },
    }).pipeThrough(new TextEncoderStream())

    const generator = toAsyncIteratorObject(stream)
    expect(generator).toSatisfy(isAsyncIteratorObject)

    expect(await generator.next()).toSatisfy(({ done, value }) => {
      expect(done).toEqual(false)
      expect(value).toEqual({ order: 1 })
      expect(getEventMeta(value)).toEqual({ id: 'id-1', retry: 10000 })

      return true
    })

    // should end if .return is called while waiting for .next()
    const nextPromise = expect(generator.next()).resolves.toEqual({ done: true, value: undefined })
    await vi.advanceTimersByTimeAsync(0)

    await generator.return(undefined)
    await nextPromise

    await vi.advanceTimersByTimeAsync(25)
    await expect(stream.getReader().closed).resolves.toBe(undefined)
  })

  it('error while reading', async () => {
    const stream = new ReadableStream<string>({
      async pull(controller) {
        controller.enqueue('event: message\ndata: {"order": 1}\nid: id-1\nretry: 10000\n\n')
        await new Promise(resolve => setTimeout(resolve, 10))
        controller.error(new Error('Test error'))
      },
    }).pipeThrough(new TextEncoderStream())

    const generator = toAsyncIteratorObject(stream)

    expect(await generator.next()).toSatisfy(({ done, value }) => {
      expect(done).toEqual(false)
      expect(value).toEqual({ order: 1 })
      expect(getEventMeta(value)).toEqual({ id: 'id-1', retry: 10000 })

      return true
    })

    const errorPromise = expect(generator.next()).rejects.toThrow('Test error')
    await vi.advanceTimersByTimeAsync(10)
    await errorPromise
  })
})

describe('toEventStream', () => {
  it('with return', async () => {
    async function* gen() {
      yield withEventMeta({ order: 1 }, { id: 'id-1' })
      yield withEventMeta({ order: 2 }, { retry: 20000 })
      yield undefined
      return withEventMeta({ order: 4 }, { id: 'id-4', retry: 40000 })
    }

    const reader = toEventStream(gen())
      .pipeThrough(new TextDecoderStream())
      .getReader()

    expect((await reader.read())).toEqual({ done: false, value: ': \n\n' })
    expect((await reader.read())).toEqual({ done: false, value: 'event: message\nid: id-1\ndata: {"order":1}\n\n' })
    expect((await reader.read())).toEqual({ done: false, value: 'event: message\nretry: 20000\ndata: {"order":2}\n\n' })
    expect((await reader.read())).toEqual({ done: false, value: 'event: message\n\n' })
    expect((await reader.read())).toEqual({ done: false, value: 'event: close\nretry: 40000\nid: id-4\ndata: {"order":4}\n\n' })
    expect((await reader.read())).toEqual({ done: true })
  })

  it('without return', async () => {
    async function* gen() {
      yield withEventMeta({ order: 1 }, { id: 'id-1' })
      yield withEventMeta({ order: 2 }, { retry: 20000 })
      yield undefined
    }

    const reader = toEventStream(gen())
      .pipeThrough(new TextDecoderStream())
      .getReader()

    expect((await reader.read())).toEqual({ done: false, value: ': \n\n' })
    expect((await reader.read())).toEqual({ done: false, value: 'event: message\nid: id-1\ndata: {"order":1}\n\n' })
    expect((await reader.read())).toEqual({ done: false, value: 'event: message\nretry: 20000\ndata: {"order":2}\n\n' })
    expect((await reader.read())).toEqual({ done: false, value: 'event: message\n\n' })
    expect((await reader.read())).toEqual({ done: false, value: 'event: close\n\n' })
    expect((await reader.read())).toEqual({ done: true })
  })

  it('with non-ErrorEvent error', async () => {
    async function* gen() {
      yield withEventMeta({ order: 1 }, { id: 'id-1' })
      yield withEventMeta({ order: 2 }, { retry: 20000 })
      yield undefined
      throw withEventMeta(new Error('order-4'), { id: 'id-4', retry: 40000 })
    }

    const reader = toEventStream(gen())
      .pipeThrough(new TextDecoderStream())
      .getReader()

    expect((await reader.read())).toEqual({ done: false, value: ': \n\n' })
    expect((await reader.read()).value).toEqual('event: message\nid: id-1\ndata: {"order":1}\n\n')
    expect((await reader.read()).value).toEqual('event: message\nretry: 20000\ndata: {"order":2}\n\n')
    expect((await reader.read()).value).toEqual('event: message\n\n')
    await expect(reader.read()).rejects.toThrow('order-4')
  })

  it('with ErrorEvent error', async () => {
    async function* gen() {
      yield withEventMeta({ order: 1 }, { id: 'id-1' })
      yield withEventMeta({ order: 2 }, { retry: 20000 })
      yield undefined
      throw withEventMeta(new ErrorEvent({ order: 4 }), { id: 'id-4', retry: 40000 })
    }

    const reader = toEventStream(gen())
      .pipeThrough(new TextDecoderStream())
      .getReader()

    expect((await reader.read())).toEqual({ done: false, value: ': \n\n' })
    expect((await reader.read()).value).toEqual('event: message\nid: id-1\ndata: {"order":1}\n\n')
    expect((await reader.read()).value).toEqual('event: message\nretry: 20000\ndata: {"order":2}\n\n')
    expect((await reader.read()).value).toEqual('event: message\n\n')
    expect((await reader.read()).value).toEqual('event: error\nretry: 40000\nid: id-4\ndata: {"order":4}\n\n')
    expect((await reader.read()).done).toEqual(true)
  })

  it.each([
    ['a BigInt', () => ({ big: 1n }), 'BigInt'],
    ['a circular reference', () => {
      const value: Record<string, unknown> = {}
      value.self = value
      return value
    }, 'circular'],
    ['a throwing toJSON', () => ({ toJSON() { throw new Error('toJSON failed') } }), 'toJSON failed'],
  ])('releases the iterator when an event has %s', async (_, value, message) => {
    let hasFinally = false

    async function* gen() {
      try {
        yield value()
        yield 2
      }
      finally {
        hasFinally = true
      }
    }

    const reader = toEventStream(gen())
      .pipeThrough(new TextDecoderStream())
      .getReader()

    expect((await reader.read())).toEqual({ done: false, value: ': \n\n' })
    await expect(reader.read()).rejects.toThrow(message)
    expect(hasFinally).toBe(true)
  })

  it('reports the serialization error when releasing the iterator throws', async () => {
    async function* gen() {
      try {
        yield { big: 1n }
      }
      finally {
        // eslint-disable-next-line no-unsafe-finally
        throw new Error('cleanup')
      }
    }

    const reader = toEventStream(gen())
      .pipeThrough(new TextDecoderStream())
      .getReader()

    await reader.read()
    await expect(reader.read()).rejects.toThrow('BigInt')
  })

  it('when canceled from client - return', async () => {
    let hasFinally = false

    async function* gen() {
      try {
        await new Promise(resolve => setTimeout(resolve, 10))
        yield 1
        await new Promise(resolve => setTimeout(resolve, 10))
        yield 2
      }
      finally {
        hasFinally = true
      }
    }

    const stream = toEventStream(gen())
    const reader = stream.getReader()

    await Promise.all([
      reader.read(),
      vi.advanceTimersByTimeAsync(10),
    ])

    reader.read()
    // start waiting for the error
    await vi.advanceTimersByTimeAsync(5)

    // Cancel before the yield 2
    await reader.cancel()

    // wait until finish
    await vi.advanceTimersByTimeAsync(5)
    expect(hasFinally).toBe(true)
  })

  it('when canceled from client - throw', async () => {
    let hasFinally = false

    async function* gen() {
      try {
        await new Promise(resolve => setTimeout(resolve, 10))
        yield 1
        await new Promise(resolve => setTimeout(resolve, 10))
        throw new Error('something')
      }
      finally {
        hasFinally = true
      }
    }

    const stream = toEventStream(gen())

    const reader = stream.getReader()

    await Promise.all([
      reader.read(),
      vi.advanceTimersByTimeAsync(10),
    ])

    reader.read()
    // start waiting for the error
    await vi.advanceTimersByTimeAsync(5)

    // Cancel before the error is thrown
    await reader.cancel()

    // finish the error throwing
    await vi.advanceTimersByTimeAsync(5)
    expect(hasFinally).toBe(true)
  })

  it('throw while cleanup', async () => {
    let hasFinally = false

    async function* gen() {
      try {
        yield 1
        await new Promise(resolve => setTimeout(resolve, 10))
        yield 2
      }
      finally {
        hasFinally = true
        // eslint-disable-next-line no-unsafe-finally
        throw new Error('something')
      }
    }

    const stream = toEventStream(gen())

    const reader = stream.getReader()
    await reader.read()

    // start iterator
    await Promise.all([
      reader.read(),
      vi.advanceTimersByTimeAsync(10),
    ])

    /**
     * This should throw, but because TextEncoderStream not rethrows cancel errors from the source stream,
     */
    await reader.cancel()
    expect(hasFinally).toBe(true)
  })

  describe('keep alive', () => {
    it('enabled', async () => {
      async function* gen() {
        for (let i = 0; i < 2; i++) {
          await new Promise(resolve => setTimeout(resolve, 100))
          yield 'hello'
        }
      }

      const stream = toEventStream(gen(), {
        initialComment: { enabled: false },
        keepAlive: { enabled: true, interval: 40, comment: 'ping' },
      })

      const reader = stream
        .pipeThrough(new TextDecoderStream())
        .getReader()

      await Promise.all([
        expect(reader.read()).resolves.toEqual({ done: false, value: ': ping\n\n' }),
        vi.advanceTimersByTimeAsync(40),
      ])

      await Promise.all([
        expect(reader.read()).resolves.toEqual({ done: false, value: ': ping\n\n' }),
        vi.advanceTimersByTimeAsync(40),
      ])

      await Promise.all([
        expect(reader.read()).resolves.toEqual({ done: false, value: 'event: message\ndata: "hello"\n\n' }),
        vi.advanceTimersByTimeAsync(20),
      ])

      await Promise.all([
        expect(reader.read()).resolves.toEqual({ done: false, value: ': ping\n\n' }),
        vi.advanceTimersByTimeAsync(40),
      ])

      await Promise.all([
        expect(reader.read()).resolves.toEqual({ done: false, value: ': ping\n\n' }),
        vi.advanceTimersByTimeAsync(40),
      ])

      await Promise.all([
        expect(reader.read()).resolves.toEqual({ done: false, value: 'event: message\ndata: "hello"\n\n' }),
        vi.advanceTimersByTimeAsync(20),
      ])

      await expect(reader.read()).resolves.toEqual({ done: false, value: 'event: close\n\n' })
      await expect(reader.read()).resolves.toEqual({ done: true })
    })

    it('disabled', async () => {
      async function* gen() {
        await new Promise(resolve => setTimeout(resolve, 100))
        yield 'hello1'
        await new Promise(resolve => setTimeout(resolve, 100))
        yield 'hello2'
      }

      const stream = toEventStream(gen(), {
        initialComment: { enabled: false },
        keepAlive: { enabled: false, interval: 40, comment: 'ping' },
      })

      const reader = stream
        .pipeThrough(new TextDecoderStream())
        .getReader()

      await Promise.all([
        expect(reader.read()).resolves.toEqual({ done: false, value: 'event: message\ndata: "hello1"\n\n' }),
        vi.advanceTimersByTimeAsync(100),
      ])

      await Promise.all([
        expect(reader.read()).resolves.toEqual({ done: false, value: 'event: message\ndata: "hello2"\n\n' }),
        vi.advanceTimersByTimeAsync(100),
      ])

      await expect(reader.read()).resolves.toEqual({ done: false, value: 'event: close\n\n' })
      await expect(reader.read()).resolves.toEqual({ done: true })
    })
  })

  describe('initial comment', () => {
    it('enabled', async () => {
      async function* gen() {
        await sleep(50)
        yield 'hello'
      }

      const stream = toEventStream(gen(), {
        initialComment: { enabled: true, comment: 'stream-started' },
        keepAlive: { enabled: false },
      })

      const reader = stream
        .pipeThrough(new TextDecoderStream())
        .getReader()

      // Initial comment is sent immediately
      await expect(reader.read()).resolves.toEqual({ done: false, value: ': stream-started\n\n' })

      await Promise.all([
        expect(reader.read()).resolves.toEqual({ done: false, value: 'event: message\ndata: "hello"\n\n' }),
        vi.advanceTimersByTimeAsync(50),
      ])

      await expect(reader.read()).resolves.toEqual({ done: false, value: 'event: close\n\n' })
      await expect(reader.read()).resolves.toEqual({ done: true })
    })

    it('disabled', async () => {
      async function* gen() {
        await sleep(50)
        yield 'hello'
      }

      const stream = toEventStream(gen(), {
        initialComment: { enabled: false },
        keepAlive: { enabled: false },
      })

      const reader = stream
        .pipeThrough(new TextDecoderStream())
        .getReader()

      await Promise.all([
        expect(reader.read()).resolves.toEqual({ done: false, value: 'event: message\ndata: "hello"\n\n' }),
        vi.advanceTimersByTimeAsync(50),
      ])

      await expect(reader.read()).resolves.toEqual({ done: false, value: 'event: close\n\n' })
      await expect(reader.read()).resolves.toEqual({ done: true })
    })
  })

  describe('empty close event', () => {
    it('enabled by default', async () => {
      async function* gen() {
        yield 'hello'
      }

      const stream = toEventStream(gen(), {
        initialComment: { enabled: false },
        keepAlive: { enabled: false },
      })

      const reader = stream
        .pipeThrough(new TextDecoderStream())
        .getReader()

      await expect(reader.read()).resolves.toEqual({ done: false, value: 'event: message\ndata: "hello"\n\n' })
      await expect(reader.read()).resolves.toEqual({ done: false, value: 'event: close\n\n' })
      await expect(reader.read()).resolves.toEqual({ done: true })
    })

    it('disabled', async () => {
      async function* gen() {
        yield 'hello'
      }

      const stream = toEventStream(gen(), {
        initialComment: { enabled: false },
        keepAlive: { enabled: false },
        emptyCloseEventEnabled: false,
      })

      const reader = stream
        .pipeThrough(new TextDecoderStream())
        .getReader()

      await expect(reader.read()).resolves.toEqual({ done: false, value: 'event: message\ndata: "hello"\n\n' })
      await expect(reader.read()).resolves.toEqual({ done: true })
    })

    it('enabled explicitly', async () => {
      async function* gen() {
        yield 'hello'
      }

      const stream = toEventStream(gen(), {
        initialComment: { enabled: false },
        keepAlive: { enabled: false },
        emptyCloseEventEnabled: true,
      })

      const reader = stream
        .pipeThrough(new TextDecoderStream())
        .getReader()

      await expect(reader.read()).resolves.toEqual({ done: false, value: 'event: message\ndata: "hello"\n\n' })
      await expect(reader.read()).resolves.toEqual({ done: false, value: 'event: close\n\n' })
      await expect(reader.read()).resolves.toEqual({ done: true })
    })

    it.each([true, false])('still sends close event when iterator returns a value: %s', async (emptyCloseEventEnabled) => {
      async function* gen() {
        yield 'hello'
        return 'bye'
      }

      const stream = toEventStream(gen(), {
        initialComment: { enabled: false },
        keepAlive: { enabled: false },
        emptyCloseEventEnabled,
      })

      const reader = stream
        .pipeThrough(new TextDecoderStream())
        .getReader()

      await expect(reader.read()).resolves.toEqual({ done: false, value: 'event: message\ndata: "hello"\n\n' })
      await expect(reader.read()).resolves.toEqual({ done: false, value: 'event: close\ndata: "bye"\n\n' })
      await expect(reader.read()).resolves.toEqual({ done: true })
    })
  })
})

it.each([
  [[1, 2, 3, 4, 5, 6]],
  [[{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }, { f: 6 }]],
])('toEventStream + toAsyncIteratorObject: %#', async (...values) => {
  const iterator = toAsyncIteratorObject(toEventStream((async function* () {
    for (const value of values) {
      await new Promise(resolve => setTimeout(resolve, 50))
      yield value
    }
  })(), { keepAlive: { enabled: true, interval: 10 } }))

  for (const expectedValue of values) {
    await Promise.all([
      expect(iterator.next()).resolves.toEqual({ done: false, value: expectedValue }),
      vi.advanceTimersByTimeAsync(50),
    ])
  }

  await iterator.next()
})
