import { ErrorEvent, unwrapEvent, withEventMeta } from '@standard-server/core'
import type { AsyncCleanupFn, Queue } from '@standard-server/shared'
import { AsyncIteratorClass, isTypescriptObject } from '@standard-server/shared'

import type { PeerEventStreamMessage } from './types'

export function toAsyncIteratorObject(
  queue: Queue<PeerEventStreamMessage>,
  cleanup: AsyncCleanupFn,
): AsyncIteratorClass<unknown> {
  return new AsyncIteratorClass(async () => {
    while (true) {
      const { json } = await queue.pull()

      switch (json.event) {
        case undefined:
        case 'message': {
          let data = json.data

          if (isTypescriptObject(data)) {
            data = withEventMeta(data, json)
          }

          return { value: data, done: false }
        }

        case 'error': {
          // Error events are surfaced by throwing a special error type
          throw withEventMeta(new ErrorEvent(json.data), json)
        }

        case 'close': {
          let data = json.data

          if (isTypescriptObject(data)) {
            data = withEventMeta(data, json)
          }

          return { value: data, done: true }
        }
      }
    }
  }, cleanup)
}

export class EventStreamTransmitter {
  private isDone = false

  /**
   * Ends the wait on the in-flight `iterator.next()`, only set while one is pending
   */
  private settlePendingNext: (() => void) | undefined

  constructor(
    private readonly iterator: AsyncIterator<unknown>,
    private readonly messageId: string,
    private readonly send: (message: PeerEventStreamMessage) => Promise<void>,
  ) {}

  async cancel(): Promise<void> {
    if (this.isDone) {
      return
    }

    this.isDone = true

    const settlePendingNext = this.settlePendingNext

    if (!settlePendingNext) {
      await this.iterator.return?.()
      return
    }

    /**
     * A native async generator queues `return()` behind the pending `next()`, so it does not
     * settle until the generator reaches its next `yield` or ends, which may never happen.
     * Stop waiting for that `next()` and request `return()` without awaiting it.
     */
    this.settlePendingNext = undefined
    settlePendingNext()

    // WARNING: errors that occur here are silently ignored.
    void Promise.resolve(this.iterator.return?.()).catch(() => {})
  }

  async transmit(): Promise<void> {
    while (true) {
      try {
        const item = await this.next()

        if (this.isDone) {
          return
        }

        if (item.done) {
          this.isDone = true
        }

        try {
          const [data, meta] = unwrapEvent(item.value)
          await this.send({
            kind: 'event-stream',
            id: this.messageId,
            json: { ...meta, event: item.done ? 'close' : undefined, data },
          })
        } catch (error) {
          await this.cancel()
          throw error
        }

        if (this.isDone) {
          return
        }
      } catch (error) {
        // ErrorEvent is part of event-stream protocol
        if (error instanceof ErrorEvent) {
          if (!this.isDone) {
            this.isDone = true

            const [resolvedError, meta] = unwrapEvent(error)
            await this.send({
              kind: 'event-stream',
              id: this.messageId,
              json: { ...meta, event: 'error', data: resolvedError.data },
            })
          }

          return
        }

        this.isDone = true
        throw error
      }
    }
  }

  /**
   * Like `iterator.next()`, but resolves `done` as soon as the transmitter is cancelled
   */
  private next(): Promise<IteratorResult<unknown>> {
    return new Promise((resolve, reject) => {
      this.settlePendingNext = () => resolve({ done: true, value: undefined })

      Promise.resolve(this.iterator.next()).then(
        (item) => {
          this.settlePendingNext = undefined
          resolve(item)
        },
        (error) => {
          this.settlePendingNext = undefined
          reject(error)
        },
      )
    })
  }
}
