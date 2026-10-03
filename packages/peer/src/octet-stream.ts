import type { AsyncCleanupFn, Queue } from '@standard-server/shared'

import type { PeerOctetStreamMessage } from './types'

export function toOctetStream(
  queue: Queue<PeerOctetStreamMessage>,
  cleanup: AsyncCleanupFn,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    async pull(controller) {
      try {
        const { json, binary } = await queue.pull()

        if (binary) {
          controller.enqueue(
            binary instanceof Uint8Array ? binary : new Uint8Array(await binary.arrayBuffer()),
          )
        }

        if (json.close) {
          await cleanup({ kind: 'success' })
          controller.close()
        }
      } catch (error) {
        await cleanup({ kind: 'error', error })
        controller.error(error)
      }
    },
    async cancel(error) {
      await cleanup({ kind: 'cancelled', error })
    },
  })
}

export class OctetStreamTransmitter {
  private isDone = false
  private readonly reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>

  constructor(
    stream: ReadableStream<Uint8Array<ArrayBuffer>>,
    private readonly messageId: string,
    private readonly send: (message: PeerOctetStreamMessage) => Promise<void>,
  ) {
    this.reader = stream.getReader()
  }

  async cancel(): Promise<void> {
    if (!this.isDone) {
      this.isDone = true
      await this.reader.cancel()
    }
  }

  async transmit(): Promise<void> {
    while (true) {
      try {
        const item = await this.reader.read()

        if (this.isDone) {
          return
        }

        if (item.done) {
          this.isDone = true
        }

        try {
          await this.send({
            json: { close: item.done ? true : undefined },
            binary: item.value,
            kind: 'octet-stream',
            id: this.messageId,
          })
        } catch (err) {
          await this.cancel()
          throw err
        }

        if (this.isDone) {
          return
        }
      } catch (error) {
        this.isDone = true
        throw error
      }
    }
  }
}
