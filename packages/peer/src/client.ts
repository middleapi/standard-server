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
   * The request message was handed to `send`, so a cancel can follow it.
   */
  requestSent?: boolean | undefined
  /**
   * Set by abortById, so transmitRequest knows the server is owed a cancel.
   */
  aborted?: boolean | undefined
  streamCancelled?: boolean | undefined
}

export class ClientPeer {
  private readonly idGenerator = new SequentialIdGenerator()
  private readonly requests = new Map<string, ClientPeerRequestStateInternal>()

  /**
   * @param send Delivers a message to the server peer. It can be called again before an earlier call
   * settles, e.g. to stream the request body or to cancel the request, and must deliver the messages of a
   * request in the order it is called for them. It may resolve as soon as the message is handed to the
   * transport, or only after the server peer has handled it. It must reject if the message cannot be delivered.
   */
  constructor(private readonly send: (message: ClientPeerSendMessage) => Promise<void>) {}

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

      /**
       * PeerRequestMessage must be sent before stream messages, but they must not wait for it to settle:
       * `send` may resolve only after the server handled the request, which can mean reading the whole body.
       */
      const requestSending = this.send({
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

      // The request can already be settled/cancelled while calling `send`
      if (this.requests.get(id) === state && !state.streamCancelled) {
        untransmittedBody = undefined

        if (isAsyncIteratorObject(request.body) || request.body instanceof ReadableStream) {
          await Promise.all([requestSending, this.transmitRequestBody(id, state, request.body)])
          return
        }
      }

      /**
       * The server ignores cancels for ids it has not seen, so a cancel must follow the request message.
       * Send one once `send` for the request message resolves if the request was aborted while calling
       * `send`, before abortById could send it, or if the request message carries a `Blob`: `send` may read it
       * before handing the message to the transport, as `encodePeerMessage` does, letting a cancel overtake it.
       */
      const cancelAfterRequestSent = state.aborted || encodedAtomicBody.binary instanceof Blob

      await requestSending

      if (cancelAfterRequestSent && state.aborted) {
        await this.send({ id, kind: 'cancel' })
      }
    } catch (reason) {
      failure = reason
      // a request message that was not sent, or failed to send, leaves nothing to cancel on the server
      await this.closeById(id, reason)
    } finally {
      if (untransmittedBody !== undefined) {
        await cancelStandardBody(untransmittedBody, failure ?? request.signal?.reason).catch(
          () => {},
        )
      }
    }
  }

  private async transmitRequestBody(
    id: string,
    state: ClientPeerRequestStateInternal,
    body: AsyncIteratorObject<unknown> | ReadableStream<Uint8Array<ArrayBuffer>>,
  ): Promise<void> {
    try {
      if (isAsyncIteratorObject(body)) {
        const transmitter = new EventStreamTransmitter(body, id, this.send)
        state.eventStreamTransmitter = transmitter
        await transmitter.transmit()
      } else {
        const transmitter = new OctetStreamTransmitter(body, id, this.send)
        state.octetStreamTransmitter = transmitter
        await transmitter.transmit()
      }
    } catch (reason) {
      // the request message is out, so tell the server to drop the request, unless it stopped reading the body
      if (!state.streamCancelled) {
        await this.abortById(id, reason)
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

    if (message.kind === 'event-stream') {
      state.eventStreamMessageQueue?.push(message)
      return
    }

    if (message.kind === 'octet-stream') {
      state.octetStreamMessageQueue?.push(message)
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
      state.octetStreamTransmitter?.cancel(reason),
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
    state.aborted = true
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
      state.octetStreamTransmitter?.cancel(reason),
    ]
    state.eventStreamTransmitter = undefined
    state.octetStreamTransmitter = undefined

    state.removeAbortListener?.()
    state.removeAbortListener = undefined

    await Promise.all(promises)
  }
}
