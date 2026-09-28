import type { AsyncCleanupFn, Queue } from '@standard-server/shared'
import type { PeerEventStreamMessage } from './types'
import { ErrorEvent, unwrapEvent, withEventMeta } from '@standard-server/core'
import { AsyncIteratorClass, isTypescriptObject } from '@standard-server/shared'

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
          throw withEventMeta(
            new ErrorEvent(json.data),
            json,
          )
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
  private isPulling = false

  constructor(
    private readonly iterator: AsyncIterator<unknown>,
    private readonly messageId: string,
    private readonly send: (message: PeerEventStreamMessage) => Promise<void>,
  ) {
  }

  async cancel(): Promise<void> {
    if (!this.isDone) {
      this.isDone = true
      const promise = this.iterator.return?.()

      if (this.isPulling) {
        /**
         * A native async generator queues `return()` behind the in-flight `next()`,
         * so it only settles once the generator yields again, which may be never.
         * Request the return without waiting for it; nothing is left to report a failure to.
         */
        void promise?.catch(() => {})
      }
      else {
        await promise
      }
    }
  }

  private async pull(): Promise<IteratorResult<unknown>> {
    this.isPulling = true

    try {
      return await this.iterator.next()
    }
    finally {
      this.isPulling = false
    }
  }

  async transmit(): Promise<void> {
    while (true) {
      try {
        const item = await this.pull()

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
        }
        catch (error) {
          await this.cancel()
          throw error
        }

        if (this.isDone) {
          return
        }
      }
      catch (error) {
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
}
