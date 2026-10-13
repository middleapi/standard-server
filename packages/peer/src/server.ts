import type { StandardBody, StandardLazyRequest, StandardResponse } from '@standard-server/core'
import { cancelStandardBody } from '@standard-server/core'
import type { Queue } from '@standard-server/shared'
import { AbortError, hasAnyDefinedValue, isAsyncIteratorObject } from '@standard-server/shared'

import { encodeAtomicStandardBody, toStandardBody } from './body'
import { EventStreamTransmitter } from './event-stream'
import { HibernationAsyncIteratorClass } from './hibernation'
import { OctetStreamTransmitter } from './octet-stream'
import type {
  ClientPeerSendMessage,
  PeerEventStreamMessage,
  PeerOctetStreamMessage,
  PeerResponseMessage,
  ServerPeerSendMessage,
} from './types'

interface ServerPeerRequestStateInternal {
  controller?: AbortController | undefined
  eventStreamMessageQueue?: Queue<PeerEventStreamMessage> | undefined
  octetStreamMessageQueue?: Queue<PeerOctetStreamMessage> | undefined
  eventStreamTransmitter?: EventStreamTransmitter | undefined
  octetStreamTransmitter?: OctetStreamTransmitter | undefined
}

export interface ServerPeerOptions {
  /**
   * Maximum number of stream messages (`event-stream`/`octet-stream`) buffered per request body
   * that the handler has not read yet. Above it the peer drops the buffer, makes reads of that
   * body reject, and sends `stream/cancel` so the client stops sending it. The request itself
   * keeps running.
   *
   * Set it when the client is untrusted: a handler that reads its body slowly, or never,
   * otherwise keeps every message the client sends in memory until the request ends.
   *
   * @default Infinity
   */
  maxBufferedStreamMessages?: number
}

export class ServerPeer {
  private readonly requests = new Map<string, ServerPeerRequestStateInternal>()
  private readonly maxBufferedStreamMessages: number

  /**
   * @param send Sends a message to the client peer. Streamed response bodies send their next
   * message only after the returned promise settles, so it is the only backpressure signal:
   * resolve it once the transport has accepted or flushed the data (e.g. the `ws` send callback),
   * not as soon as the data is queued.
   */
  constructor(
    private readonly send: (message: ServerPeerSendMessage) => Promise<void>,
    options: ServerPeerOptions = {},
  ) {
    this.maxBufferedStreamMessages = options.maxBufferedStreamMessages ?? Number.POSITIVE_INFINITY
  }

  /**
   * Handle a message from client
   */
  async message(
    message: ClientPeerSendMessage,
    handleRequest: (request: StandardLazyRequest) => Promise<StandardResponse>,
  ): Promise<void> {
    const id = message.id

    if (message.kind === 'cancel') {
      await this.closeById(id, new AbortError('Client aborted the request'))
      return
    }

    if (message.kind === 'event-stream') {
      const state = this.requests.get(id)
      await this.pushStreamMessage(id, state, state?.eventStreamMessageQueue, message)
      return
    }

    if (message.kind === 'octet-stream') {
      const state = this.requests.get(id)
      await this.pushStreamMessage(id, state, state?.octetStreamMessageQueue, message)
      return
    }

    if (this.requests.has(id)) {
      // duplicate request message
      return
    }

    const controller = new AbortController()
    const state: ServerPeerRequestStateInternal = { controller }
    this.requests.set(id, state)
    const signal = controller.signal

    let untransmittedBody: StandardBody | undefined

    try {
      const decoded = toStandardBody(message, async ({ kind, error }) => {
        /**
         * The request body is finished (fully read, errored, or cancelled).
         * Abort the queues so nothing is left waiting on them, then drop them
         * so late stream messages are ignored instead of buffered forever.
         */
        const streamActive =
          state.eventStreamMessageQueue !== undefined || state.octetStreamMessageQueue !== undefined

        state.eventStreamMessageQueue?.abort(error)
        state.octetStreamMessageQueue?.abort(error)
        state.eventStreamMessageQueue = undefined
        state.octetStreamMessageQueue = undefined

        if (kind === 'cancelled' && streamActive) {
          // only need cancel stream if streams is still active
          await this.send({ id, kind: 'stream/cancel' })
        }
      })
      state.eventStreamMessageQueue = decoded.eventStreamMessageQueue
      state.octetStreamMessageQueue = decoded.octetStreamMessageQueue

      const response = await handleRequest({
        url: message.json.url,
        method: message.json.method ?? 'POST',
        headers: message.json.headers ?? {},
        resolveBody: decoded.resolveBody,
        signal,
      })
      untransmittedBody = response.body

      // only send message if still open and not aborted
      if (signal.aborted) {
        return
      }

      const encodedAtomicBody = await encodeAtomicStandardBody(response.body, response.headers)

      // signal can abort during encode
      if (signal.aborted) {
        return
      }

      const responseMessage: PeerResponseMessage = {
        id,
        kind: 'response',
        json: {
          status: response.status === 200 ? undefined : response.status,
          headers: hasAnyDefinedValue(encodedAtomicBody.headers)
            ? encodedAtomicBody.headers
            : undefined,
          body: encodedAtomicBody.jsonBody,
        },
        binary: encodedAtomicBody.binary,
      }

      // PeerResponseMessage must be sent before stream messages
      await this.send(responseMessage)

      // signal can abort during send response message
      if (signal.aborted) {
        return
      }

      untransmittedBody = undefined

      if (isAsyncIteratorObject(response.body)) {
        if (response.body instanceof HibernationAsyncIteratorClass) {
          try {
            await response.body['~callback']?.(id)
          } finally {
            await response.body.return()
          }
        } else {
          const transmitter = new EventStreamTransmitter(response.body, id, this.send)
          state.eventStreamTransmitter = transmitter
          await transmitter.transmit().catch(async (reason) => {
            // only cancel if stream transmitter is still active
            if (state.eventStreamTransmitter) {
              await this.cancelById(id, reason)
            }

            // WARNING: errors that occur here are silently ignored.
          })
        }
      } else if (response.body instanceof ReadableStream) {
        const transmitter = new OctetStreamTransmitter(response.body, id, this.send)
        state.octetStreamTransmitter = transmitter
        await transmitter.transmit().catch(async (reason) => {
          // only cancel if stream transmitter is still active
          if (state.octetStreamTransmitter) {
            await this.cancelById(id, reason)
          }

          // WARNING: errors that occur here are silently ignored.
        })
      }

      // close without aborting, because the request is finished successfully
      state.controller = undefined
      await this.closeById(id)
    } catch (reason) {
      await this.cancelById(id, reason)
      throw reason
    } finally {
      if (untransmittedBody !== undefined) {
        await cancelStandardBody(untransmittedBody, signal.reason)
      }
    }
  }

  private async pushStreamMessage<T>(
    id: string,
    state: ServerPeerRequestStateInternal | undefined,
    queue: Queue<T> | undefined,
    message: T,
  ): Promise<void> {
    if (!state || !queue) {
      return
    }

    if (queue.size < this.maxBufferedStreamMessages) {
      queue.push(message)
      return
    }

    /**
     * The handler is not keeping up with the request body. Drop the buffer, so body reads reject,
     * and drop the queue so later stream messages are ignored. The request itself keeps running.
     */
    queue.abort(
      new Error(
        `Request body exceeded ${this.maxBufferedStreamMessages} unread stream messages (maxBufferedStreamMessages)`,
      ),
    )
    state.eventStreamMessageQueue = undefined
    state.octetStreamMessageQueue = undefined

    await this.send({ id, kind: 'stream/cancel' })
  }

  async close(reason?: unknown): Promise<void> {
    reason ??= new AbortError('Peer was closed')

    await Promise.all(Array.from(this.requests.keys()).map((id) => this.closeById(id, reason)))
  }

  private async closeById(id: string, reason?: unknown): Promise<void> {
    const state = this.requests.get(id)

    if (!state) {
      // already closed or aborted
      return
    }

    this.requests.delete(id)

    if (state.controller || state.eventStreamMessageQueue || state.octetStreamMessageQueue) {
      reason ??= new AbortError('Request was closed')
    }

    state.controller?.abort(reason)
    state.controller = undefined

    state.eventStreamMessageQueue?.close(reason)
    state.octetStreamMessageQueue?.close(reason)
    state.eventStreamMessageQueue = undefined
    state.octetStreamMessageQueue = undefined

    const promises = [
      state.eventStreamTransmitter?.cancel(),
      state.octetStreamTransmitter?.cancel(),
    ]
    state.eventStreamTransmitter = undefined
    state.octetStreamTransmitter = undefined

    await Promise.all(promises)
  }

  private async cancelById(id: string, reason?: unknown): Promise<void> {
    await Promise.all([
      /**
       * Do not need to send cancel message if request was closed or aborted
       */
      this.requests.has(id) ? this.send({ id, kind: 'cancel' }) : undefined,
      this.closeById(id, reason),
    ])
  }
}
