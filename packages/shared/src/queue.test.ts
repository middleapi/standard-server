import { AbortError } from './error'
import { Queue } from './queue'

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

  it('keeps order across internal compaction', async () => {
    const queue = new Queue<number>()

    // Splices the pulled half at 1024, then fully drains the remaining 1024.
    for (let i = 0; i < 2048; i++) {
      queue.push(i)
    }

    for (let i = 0; i < 2048; i++) {
      expect(await queue.pull()).toBe(i)
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
