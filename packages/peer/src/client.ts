import type { StandardBody, StandardLazyResponse, StandardRequest } from '@standard-server/core'
import type { Queue } from '@standard-server/shared'
import type { ClientPeerSendMessage, PeerEventStreamMessage, PeerOctetStreamMessage, ServerPeerSendMessage } from './types'
import { cancelStandardBody } from '@standard-server/core'
import { AbortError, hasAnyDefinedValue, isAsyncIteratorObject, SequentialIdGenerator } from '@standard-server/shared'
import { encodeAtomicStandardBody, toStandardBody } from './body'
import { EventStreamTransmitter } from './event-stream'
import { OctetStreamTransmitter } from './octet-stream'

interface ClientPeerRequestStateInternal {
  resolve?: ((response: StandardLazyResponse) => void) | undefined
  reject?: ((reason: unknown) => void) | undefined
  eventStreamMessageQueue?: Queue<PeerEventStreamMessage> | undefined
  octetStreamMessageQueue?: Queue<PeerOctetStreamMessage> | undefined
  eventStreamTransmitter?: EventStreamTransmitter | undefined
  octetStreamTransmitter?: OctetStreamTransmitter | undefined
  removeAbortListener?: (() => void) | undefined
}

export class ClientPeer {
  private readonly idGenerator = new SequentialIdGenerator()
  private readonly requests = new Map<string, ClientPeerRequestStateInternal>()

  constructor(
    private readonly send: (message: ClientPeerSendMessage) => Promise<void>,
  ) {
  }

  /**
   * Send a request to the server peer
   */
  request(request: StandardRequest): Promise<StandardLazyResponse> {
    return new Promise<StandardLazyResponse>((resolve, reject) => {
      const signal = request.signal
      signal?.throwIfAborted()

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

      void this.transmitRequest(id, state, request)
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
      const encodedAtomicBody = await encodeAtomicStandardBody(request.body, request.headers)

      // signal can be aborted during encode
      request.signal?.throwIfAborted()

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
          headers: hasAnyDefinedValue(encodedAtomicBody.headers) ? encodedAtomicBody.headers : undefined,
          body: encodedAtomicBody.jsonBody,
        },
        binary: encodedAtomicBody.binary,
      })

      // The request can already be settled/cancelled while was in flight
      if (this.requests.get(id) !== state) {
        return
      }

      untransmittedBody = undefined

      if (isAsyncIteratorObject(request.body)) {
        const transmitter = new EventStreamTransmitter(request.body, id, this.send)
        state.eventStreamTransmitter = transmitter
        await transmitter.transmit().catch((error) => {
          if (state.eventStreamTransmitter) {
            return this.abortById(id, error)
          }
        })
      }
      else if (request.body instanceof ReadableStream) {
        const transmitter = new OctetStreamTransmitter(request.body, id, this.send)
        state.octetStreamTransmitter = transmitter
        await transmitter.transmit().catch((error) => {
          if (state.octetStreamTransmitter) {
            return this.abortById(id, error)
          }
        })
      }
    }
    catch (reason) {
      failure = reason
      await this.closeById(id, reason)
    }
    finally {
      if (untransmittedBody !== undefined) {
        await cancelStandardBody(untransmittedBody, failure ?? request.signal?.reason).catch(() => {})
      }
    }
  }

  /**
   * Handle a message from server
   */
  async message(
    message: ServerPeerSendMessage,
  ): Promise<void> {
    const id = message.id
    const state = this.requests.get(id)

    if (!state) { // request already closed or non-existing
      return
    }

    if (message.kind === 'stream/cancel') {
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

    if (!state.resolve) { // duplicate response message
      return
    }

    const resolve = state.resolve
    state.resolve = undefined

    try {
      const decoded = toStandardBody(message, async (cleanupState) => {
        if (cleanupState.kind === 'cancelled') {
          await this.abortById(id, cleanupState.error)
        }
        else if (state.eventStreamMessageQueue || state.octetStreamMessageQueue) {
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
    }
    catch (reason) {
      await this.closeById(id, reason)
    }
  }

  async close(reason?: unknown): Promise<void> {
    reason ??= new AbortError('Peer was closed')

    await Promise.all(
      Array.from(this.requests.keys()).map(id => this.closeById(id, reason)),
    )
  }

  private async closeById(id: string, reason?: unknown): Promise<void> {
    const state = this.requests.get(id)

    if (!state) { // already closed
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

    if (!state) { // already closed
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
      this.send({ id, kind: 'cancel' }),
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
