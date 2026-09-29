import { AbortError } from './error'

const COMPACT_THRESHOLD = 1024

const sizeOfOne = (): number => 1

export interface QueueOptions<T> {
  /**
   * Maximum number of buffered items, i.e. pushed but not yet pulled.
   * Items handed straight to a waiting `pull()` are never buffered, so they do not count.
   *
   * @default Infinity
   */
  maxItems?: number | undefined

  /**
   * Maximum total size of buffered items, as measured by `sizeOf`.
   *
   * @default Infinity
   */
  maxSize?: number | undefined

  /**
   * Measures an item against `maxSize`.
   * Must return the same value every time it is called with the same item.
   *
   * @default () => 1
   */
  sizeOf?: ((item: T) => number) | undefined
}

/**
 * Thrown by `Queue.push()` when buffering the item would exceed `maxItems` or `maxSize`.
 */
export class QueueOverflowError extends Error {
  constructor(...rest: ConstructorParameters<typeof Error>) {
    super(...rest)
    this.name = 'QueueOverflowError'
  }
}

export class Queue<T> {
  /** Items before `head` have already been pulled. */
  private readonly items: (T | undefined)[] = []
  private head = 0
  private readonly pendingPulls: (readonly [resolve: (item: T) => void, reject: (err: unknown) => void])[] = []
  private closed: undefined | { reason: unknown }

  private readonly maxItems: number
  private readonly maxSize: number | undefined
  private readonly sizeOf: (item: T) => number
  /** Only tracked when `maxSize` is set, so an unbounded queue never measures its items. */
  private bufferedSize = 0

  constructor(options: QueueOptions<T> = {}) {
    this.maxItems = options.maxItems ?? Infinity
    this.maxSize = options.maxSize
    this.sizeOf = options.sizeOf ?? sizeOfOne
  }

  /**
   * Pushes an item into the queue.
   * @throws when the queue is closed or aborted
   * @throws {QueueOverflowError} when buffering the item would exceed `maxItems` or `maxSize`. The item is not buffered and the queue stays open.
   */
  push(item: T): void {
    if (this.closed) {
      throw this.closed.reason
    }

    const pendingPull = this.pendingPulls.shift()

    if (pendingPull) {
      pendingPull[0](item)
      return
    }

    if (this.items.length - this.head >= this.maxItems) {
      throw new QueueOverflowError(`Queue cannot buffer more than ${this.maxItems} items.`)
    }

    if (this.maxSize !== undefined) {
      const size = this.sizeOf(item)

      if (this.bufferedSize + size > this.maxSize) {
        throw new QueueOverflowError(`Queue cannot buffer more than a total size of ${this.maxSize}.`)
      }

      this.bufferedSize += size
    }

    this.items.push(item)
  }

  /**
   * Pulls the next item from the queue.
   *
   * @throws when the queue is closed or aborted. Note that buffered items can still be pulled after close until the buffer is drained.
   */
  async pull(): Promise<T> {
    if (this.head < this.items.length) {
      const item = this.items[this.head] as T
      this.items[this.head++] = undefined // release the reference so pulled items can be GC'd

      if (this.maxSize !== undefined) {
        // reset once drained, so an inconsistent `sizeOf` cannot leave the size drifting
        this.bufferedSize = this.head === this.items.length ? 0 : this.bufferedSize - this.sizeOf(item)
      }

      // Compact once at least half the array is consumed, so the O(n) splice is amortized O(1) per pull.
      if (this.head >= COMPACT_THRESHOLD && this.head * 2 >= this.items.length) {
        if (this.head === this.items.length) {
          this.items.length = 0
        }
        else {
          this.items.splice(0, this.head)
        }

        this.head = 0
      }

      return item
    }

    if (this.closed) {
      throw this.closed.reason
    }

    return new Promise<T>((resolve, reject) => {
      this.pendingPulls.push([resolve, reject])
    })
  }

  /**
   * Closes the queue and rejects any pending pulls.
   * Buffered items remain available to be pulled. Repeated calls are ignored.
   */
  close(reason?: unknown): void {
    if (this.closed) {
      return
    }

    reason ??= new AbortError('Queue was closed.')
    this.closed = { reason }

    this.pendingPulls.forEach(([, reject]) => reject(reason))
    this.pendingPulls.length = 0
  }

  /**
   * Aborts the queue.
   * Unlike `close()`, this also discards any buffered items before closing.
   */
  abort(reason?: unknown): void {
    reason ??= new AbortError('Queue was aborted.')
    this.items.length = 0
    this.head = 0
    this.close(reason)
  }
}
