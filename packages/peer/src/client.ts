import type { StandardBody, StandardLazyResponse, StandardRequest } from '@standard-server/core'
import { cancelStandardBody } from '@standard-server/core'
import type { Queue } from '@standard-server/shared'
import {
  AbortError,
  hasAnyDefinedValue,
  isAsyncIteratorObject,
  SequentialIdGenerator,
  throwIfAborted,
} from '@standard-server/shared'

import { encodeAtomicStandardBody, toStandardBody } from './body'
import { EventStreamTransmitter } from './event-stream'
import { OctetStreamTransmitter } from './octet-stream'
import type {
  ClientPeerSendMessage,
  PeerEventStreamMessage,
  PeerOctetStreamMessage,
  ServerPeerSendMessage,
} from './types'

interface ClientPeerRequestStateInternal {
  resolve?: ((response: StandardLazyResponse) => void) | undefined
  reject?: ((reason: unknown) => void) | undefined
  eventStreamMessageQueue?: Queue<PeerEventStreamMessage> | undefined
  octetStreamMessageQueue?: Queue<PeerOctetStreamMessage> | undefined
  eventStreamTransmitter?: EventStreamTransmitter | undefined
  octetStreamTransmitter?: OctetStreamTransmitter | undefined
  removeAbortListener?: (() => void) | undefined
  /**
   * A cancel must not overtake the request message (the server ignores cancels for unknown ids),
   * so until the request message is sent, transmitRequest sends the cancel instead of abortById.
   */
  requestSent?: boolean | undefined
  streamCancelled?: boolean | undefined
}

export interface ClientPeerOptions {
  /**
   * Maximum number of stream messages (`event-stream`/`octet-stream`) buffered per response body
   * that has not been read yet. Above it the peer drops the buffer, makes reads of that body
   * reject, and cancels the request.
   *
   * Set it when the server is untrusted: a response body that is read slowly, or never,
   * otherwise keeps every message the server sends in memory until the request ends.
   *
   * @default Infinity
   */
  maxBufferedStreamMessages?: number
}

export class ClientPeer {
  private readonly idGenerator = new SequentialIdGenerator()
  private readonly requests = new Map<string, ClientPeerRequestStateInternal>()
  private readonly maxBufferedStreamMessages: number

  /**
   * @param send Sends a message to the server peer. Streamed request bodies send their next
   * message only after the returned promise settles, so it is the only backpressure signal:
   * resolve it once the transport has accepted or flushed the data (e.g. the `ws` send callback),
   * not as soon as the data is queued.
   */
  constructor(
    private readonly send: (message: ClientPeerSendMessage) => Promise<void>,
    options: ClientPeerOptions = {},
  ) {
    this.maxBufferedStreamMessages = options.maxBufferedStreamMessages ?? Number.POSITIVE_INFINITY
  }

  /**
   * Send a request to the server peer
   */
  request(request: StandardRequest): Promise<StandardLazyResponse> {
    return new Promise<StandardLazyResponse>((resolve, reject) => {
      const signal = request.signal
      const id = this.idGenerator.generate()
      const state: ClientPeerRequestStateInternal = { resolve, reject }
      this.requests.set(id, state)

      if (signal) {
        const abortListener = () => {
          // a failed cancel delivery must not surface as an unhandled rejection
          void this.abortById(id, signal.reason).catch(() => {})
        }
        signal.addEventListener('abort', abortListener)
        /**
         * Make sure to remove the abort listener when the request/response is closed.
         * Since a signal can be reused for multiple requests, if each request
         * adds listeners without removing them, it can lead to excessive memory usage
         * until the signal is garbage collected.
         */
        state.removeAbortListener = () => signal.removeEventListener('abort', abortListener)
      }

      void this.transmitRequest(id, state, request).catch(() => {})
    })
  }

  private async transmitRequest(
    id: string,
    state: ClientPeerRequestStateInternal,
    request: StandardRequest,
  ): Promise<void> {
    let untransmittedBody: StandardBody | undefined = request.body
    let failure: unknown

    try {
      throwIfAborted(request.signal)

      const encodedAtomicBody = await encodeAtomicStandardBody(request.body, request.headers)

      // signal can be aborted during encode
      throwIfAborted(request.signal)

      // the peer can be closed during encode
      if (this.requests.get(id) !== state) {
        return
      }

      // PeerRequestMessage must be sent before stream messages
      await this.send({
        id,
        kind: 'request',
        json: {
          method: request.method === 'POST' ? undefined : request.method,
          url: request.url,
          headers: hasAnyDefinedValue(encodedAtomicBody.headers)
            ? encodedAtomicBody.headers
            : undefined,
          body: encodedAtomicBody.jsonBody,
        },
        binary: encodedAtomicBody.binary,
      })
      state.requestSent = true

      // The request can already be settled/cancelled while was in flight
      if (this.requests.get(id) !== state) {
        if (request.signal?.aborted) {
          await this.send({ id, kind: 'cancel' })
        }

        return
      }

      if (state.streamCancelled) {
        return
      }

      untransmittedBody = undefined

      if (isAsyncIteratorObject(request.body)) {
        const transmitter = new EventStreamTransmitter(request.body, id, this.send)
        state.eventStreamTransmitter = transmitter
        await transmitter.transmit()
      } else if (request.body instanceof ReadableStream) {
        const transmitter = new OctetStreamTransmitter(request.body, id, this.send)
        state.octetStreamTransmitter = transmitter
        await transmitter.transmit()
      }
    } catch (reason) {
      failure = reason

      if (!state.requestSent) {
        await this.closeById(id, reason)
      } else if (!state.streamCancelled) {
        await this.abortById(id, reason)
      }
    } finally {
      if (untransmittedBody !== undefined) {
        await cancelStandardBody(untransmittedBody, failure ?? request.signal?.reason).catch(
          () => {},
        )
      }
    }
  }

  /**
   * Handle a message from server
   */
  async message(message: ServerPeerSendMessage): Promise<void> {
    const id = message.id
    const state = this.requests.get(id)

    if (!state) {
      // request already closed or non-existing
      return
    }

    if (message.kind === 'stream/cancel') {
      state.streamCancelled = true
      const promise = Promise.all([
        state.eventStreamTransmitter?.cancel(),
        state.octetStreamTransmitter?.cancel(),
      ])
      state.eventStreamTransmitter = undefined
      state.octetStreamTransmitter = undefined

      await promise
      return
    }

    if (message.kind === 'cancel') {
      await this.closeById(id, new AbortError('Server canceled the request'))
      return
    }

    if (message.kind === 'event-stream' || message.kind === 'octet-stream') {
      const queue =
        message.kind === 'event-stream'
          ? state.eventStreamMessageQueue
          : state.octetStreamMessageQueue

      if (queue && queue.size >= this.maxBufferedStreamMessages) {
        const error = new Error(
          `Response body exceeded ${this.maxBufferedStreamMessages} unread stream messages (maxBufferedStreamMessages)`,
        )
        await this.abortById(id, error)
        return
      }
    }

    // by the last stream message the server has already released the request, so release it too
    if (message.kind === 'event-stream') {
      const queue = state.eventStreamMessageQueue
      queue?.push(message)

      if (queue && (message.json.event === 'close' || message.json.event === 'error')) {
        await this.closeById(id)
      }

      return
    }

    if (message.kind === 'octet-stream') {
      const queue = state.octetStreamMessageQueue
      queue?.push(message)

      if (queue && message.json.close) {
        await this.closeById(id)
      }

      return
    }

    if (!state.resolve) {
      // duplicate response message
      return
    }

    const resolve = state.resolve
    state.resolve = undefined

    try {
      const decoded = toStandardBody(message, async (cleanupState) => {
        if (cleanupState.kind === 'cancelled') {
          await this.abortById(id, cleanupState.error)
        } else if (state.eventStreamMessageQueue || state.octetStreamMessageQueue) {
          await this.closeById(id, cleanupState.error)
        }
      })
      state.eventStreamMessageQueue = decoded.eventStreamMessageQueue
      state.octetStreamMessageQueue = decoded.octetStreamMessageQueue

      resolve({
        headers: message.json.headers ?? {},
        status: message.json.status ?? 200,
        resolveBody: decoded.resolveBody,
      })
      state.reject = undefined

      if (!state.eventStreamMessageQueue && !state.octetStreamMessageQueue) {
        // if there is no stream, we can close the request immediately
        await this.closeById(id)
      }
    } catch (reason) {
      await this.closeById(id, reason)
    }
  }

  async close(reason?: unknown): Promise<void> {
    reason ??= new AbortError('Peer was closed')

    await Promise.all(Array.from(this.requests.keys()).map((id) => this.closeById(id, reason)))
  }

  private async closeById(id: string, reason?: unknown): Promise<void> {
    const state = this.requests.get(id)

    if (!state) {
      // already closed
      return
    }

    this.requests.delete(id)

    // avoid allocating an error (and its stack trace) when nothing observes the reason
    if (state.reject || state.eventStreamMessageQueue || state.octetStreamMessageQueue) {
      reason ??= new AbortError('Request was closed')
    }

    state.reject?.(reason)
    state.resolve = undefined
    state.reject = undefined

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

    state.removeAbortListener?.()
    state.removeAbortListener = undefined

    await Promise.all(promises)
  }

  private async abortById(id: string, reason: unknown): Promise<void> {
    const state = this.requests.get(id)

    if (!state) {
      // already closed
      return
    }

    this.requests.delete(id)
    reason ??= new AbortError('Request was aborted')

    state.reject?.(reason)
    state.resolve = undefined
    state.reject = undefined

    state.eventStreamMessageQueue?.abort(reason)
    state.octetStreamMessageQueue?.abort(reason)
    state.eventStreamMessageQueue = undefined
    state.octetStreamMessageQueue = undefined

    const promises = [
      state.requestSent ? this.send({ id, kind: 'cancel' }) : undefined,
      state.eventStreamTransmitter?.cancel(),
      state.octetStreamTransmitter?.cancel(),
    ]
    state.eventStreamTransmitter = undefined
    state.octetStreamTransmitter = undefined

    state.removeAbortListener?.()
    state.removeAbortListener = undefined

    await Promise.all(promises)
  }
}
