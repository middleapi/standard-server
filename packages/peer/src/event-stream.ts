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

  constructor(
    private readonly iterator: AsyncIterator<unknown>,
    private readonly messageId: string,
    private readonly send: (message: PeerEventStreamMessage) => Promise<void>,
  ) {}

  async cancel(): Promise<void> {
    if (!this.isDone) {
      this.isDone = true
      await this.iterator.return?.()
    }
  }

  async transmit(): Promise<void> {
    while (true) {
      try {
        const item = await this.iterator.next()

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
}
