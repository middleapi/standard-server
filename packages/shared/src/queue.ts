import { AbortError } from './error'

const COMPACT_THRESHOLD = 1024

export class Queue<T> {
  /** Items before `head` have already been pulled. */
  private readonly items: (T | undefined)[] = []
  private head = 0
  private readonly pendingPulls: (readonly [resolve: (item: T) => void, reject: (err: unknown) => void])[] = []
  private closed: undefined | { reason: unknown }

  /**
   * Pushes an item into the queue.
   * @throws when the queue is closed or aborted
   */
  push(item: T): void {
    if (this.closed) {
      throw this.closed.reason
    }

    const pendingPull = this.pendingPulls.shift()

    if (pendingPull) {
      pendingPull[0](item)
    }
    else {
      this.items.push(item)
    }
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
