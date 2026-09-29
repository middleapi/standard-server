import { AbortError } from './error'
import { Queue, QueueOverflowError } from './queue'

describe('queue', () => {
  it('returns buffered items in order', async () => {
    const queue = new Queue<string>()

    queue.push('a')
    queue.push('b')

    expect(await queue.pull()).toBe('a')
    expect(await queue.pull()).toBe('b')
  })

  it('returns buffered undefined items in order', async () => {
    const queue = new Queue<string | undefined>()

    queue.push(undefined)
    queue.push('a')

    expect(await queue.pull()).toBeUndefined()
    expect(await queue.pull()).toBe('a')
  })

  it('keeps order across internal compaction, including undefined items', async () => {
    const queue = new Queue<number | undefined>()
    const value = (i: number) => i % 3 === 0 ? undefined : i

    // Splices the pulled half at 1024, then fully drains the remaining 1024.
    for (let i = 0; i < 2048; i++) {
      queue.push(value(i))
    }

    for (let i = 0; i < 2048; i++) {
      expect(await queue.pull()).toBe(value(i))
    }

    queue.push(2048)
    expect(await queue.pull()).toBe(2048)
  })

  it('resolves a pending pull on push', async () => {
    const queue = new Queue<string>()

    const p = queue.pull()

    queue.push('a')

    await expect(p).resolves.toBe('a')
  })

  it('throws on push after close', () => {
    const queue = new Queue<string>()

    queue.close()

    expect(() => queue.push('a')).toThrow(AbortError)
  })

  it('drains buffered items before rejecting after close', async () => {
    const queue = new Queue<string>()

    queue.push('a')
    queue.push('b')
    queue.close()

    await expect(queue.pull()).resolves.toBe('a')
    await expect(queue.pull()).resolves.toBe('b')
    await expect(queue.pull()).rejects.toThrow(AbortError)
  })

  it('rejects pending pulls with the close reason', async () => {
    const queue = new Queue<string>()

    const p = queue.pull()
    const err = new Error('custom')

    queue.close(err)

    await expect(p).rejects.toBe(err)
  })

  it('ignores repeated close calls', async () => {
    const queue = new Queue<string>()

    const p = queue.pull()

    queue.close('first close')
    queue.close('second close')

    await expect(p).rejects.toBe('first close')
  })

  it('abort clears buffered items and rejects future pulls', async () => {
    const queue = new Queue<string>()

    queue.push('1')
    queue.abort()

    await expect(queue.pull()).rejects.toThrow('Queue was aborted.')
  })

  describe('limits', () => {
    it('throws QueueOverflowError when buffering more than maxItems', async () => {
      const queue = new Queue<string>({ maxItems: 2 })

      queue.push('a')
      queue.push('b')

      expect(() => queue.push('c')).toThrow(QueueOverflowError)
      expect(() => queue.push('c')).toThrow('Queue cannot buffer more than 2 items.')

      // the rejected item is not buffered and the queue stays open
      expect(await queue.pull()).toBe('a')
      queue.push('d')
      expect(await queue.pull()).toBe('b')
      expect(await queue.pull()).toBe('d')
    })

    it('throws QueueOverflowError when buffering more than maxSize', async () => {
      const queue = new Queue<string>({ maxSize: 5, sizeOf: item => item.length })

      queue.push('ab')
      queue.push('cde')

      expect(() => queue.push('f')).toThrow(QueueOverflowError)
      expect(() => queue.push('f')).toThrow('Queue cannot buffer more than a total size of 5.')

      // pulling frees the size of the pulled item
      expect(await queue.pull()).toBe('ab')
      queue.push('fg')
      expect(() => queue.push('h')).toThrow(QueueOverflowError)

      expect(await queue.pull()).toBe('cde')
      expect(await queue.pull()).toBe('fg')
    })

    it('rejects a single item larger than maxSize', () => {
      const queue = new Queue<string>({ maxSize: 2, sizeOf: item => item.length })

      expect(() => queue.push('abc')).toThrow(QueueOverflowError)
    })

    it('counts each item as 1 against maxSize by default', () => {
      const queue = new Queue<string>({ maxSize: 1 })

      queue.push('abc')
      expect(() => queue.push('d')).toThrow(QueueOverflowError)
    })

    it('does not count items handed straight to a pending pull', async () => {
      const queue = new Queue<string>({ maxItems: 1, maxSize: 1, sizeOf: item => item.length })

      const pull = queue.pull()
      queue.push('abc')
      await expect(pull).resolves.toBe('abc')

      queue.push('d')
      expect(() => queue.push('e')).toThrow(QueueOverflowError)
    })

    it('resets the buffered size once drained, even if sizeOf is inconsistent', async () => {
      let size = 1
      const queue = new Queue<string>({ maxSize: 2, sizeOf: () => size })

      queue.push('a')
      queue.push('b')
      size = 0
      expect(await queue.pull()).toBe('a')
      expect(await queue.pull()).toBe('b')

      size = 1
      queue.push('c')
      queue.push('d')
      expect(() => queue.push('e')).toThrow(QueueOverflowError)
    })

    it('throws the close reason rather than an overflow once closed', () => {
      const queue = new Queue<string>({ maxItems: 1 })

      queue.push('a')
      queue.abort()

      expect(() => queue.push('b')).toThrow('Queue was aborted.')
    })

    it('keeps limits across internal compaction', async () => {
      const queue = new Queue<number>({ maxItems: 2048, maxSize: 2048 })

      for (let i = 0; i < 2048; i++) {
        queue.push(i)
      }

      expect(() => queue.push(2048)).toThrow(QueueOverflowError)

      for (let i = 0; i < 1024; i++) {
        expect(await queue.pull()).toBe(i)
      }

      for (let i = 2048; i < 3072; i++) {
        queue.push(i)
      }

      expect(() => queue.push(3072)).toThrow(QueueOverflowError)

      for (let i = 1024; i < 3072; i++) {
        expect(await queue.pull()).toBe(i)
      }
    })
  })

  it('concurrent pull/push/close', async () => {
    const queue = new Queue<string>()

    queue.push('1')
    queue.push('2')

    const promise = Promise.all([
      expect(queue.pull()).resolves.toBe('1'),
      expect(queue.pull()).resolves.toBe('2'),
      expect(queue.pull()).resolves.toBe('3'),
      expect(queue.pull()).resolves.toBe('4'),
      expect(queue.pull()).rejects.toThrow(AbortError),
    ])

    queue.push('3')
    queue.push('4')
    queue.close()

    await promise
  })
})
