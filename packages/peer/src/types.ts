import type {
  EventMeta,
  StandardBody,
  StandardHeaders,
  StandardMethod,
  StandardUrl,
} from '@standard-server/core'

/**
 * Base interface for all peer messages.
 *
 * All payloads should be compatible with the structured clone algorithm.
 */
export interface PeerMessage {
  /**
   * Correlation ID shared by a request, its response, and any related stream messages.
   */
  id: string
  /**
   * Message discriminator. Determines the payload shape and semantics.
   */
  kind: string
  /**
   * Structured payload. Shape is determined by `kind`.
   */
  json?: unknown
  /**
   * Binary payload. Only present for message kinds that support binary transfer.
   */
  binary?: Uint8Array<ArrayBuffer> | Blob | undefined
}

/**
 * Initiates a request from client to server.
 *
 * Always the first message in requesting lifecycle.
 */
export interface PeerRequestMessage extends PeerMessage {
  /**
   * Message kind.
   */
  kind: 'request'
  /**
   * Request payload, excluding the abort signal.
   */
  json: {
    /**
     * @example 'GET', 'POST', etc.
     * @default 'POST'
     */
    method?: undefined | StandardMethod
    /**
     * @example `/example`, `/example?query=param#fragment`
     */
    url: StandardUrl
    /**
     * @example { 'content-type': 'application/json' }
     * @default {}
     */
    headers?: undefined | StandardHeaders
    /**
     * The JSON-parsed body of the request.
     */
    body?: undefined | StandardBody
  }
}

/**
 * Delivers the response from server to client.
 *
 * Always the first message in responding lifecycle.
 */
export interface PeerResponseMessage extends PeerMessage {
  /**
   * Message kind.
   */
  kind: 'response'
  /**
   * Response payload.
   */
  json: {
    /**
     * @example 200, 404, 500, etc.
     * @default 200
     */
    status?: undefined | number
    /**
     * @example { 'set-cookie': ['sessionId=abc123; HttpOnly'] }
     * @default {}
     */
    headers?: undefined | StandardHeaders
    /**
     * The JSON-parsed body of the response.
     */
    body?: undefined | StandardBody
  }
}

/**
 * Cancels or aborts a request, response, or stream.
 *
 * - **Client → Server**: Cancel an in-flight request or stop consuming a stream.
 * - **Server → Client**: Signal an error or premature termination.
 */
export interface PeerCancelMessage extends PeerMessage {
  /**
   * Message kind.
   */
  kind: 'cancel'
  /**
   * Cancel messages carry no JSON payload.
   */
  json?: undefined
  /**
   * Cancel messages carry no binary payload.
   */
  binary?: undefined
}

/**
 * Carries one event in an event stream.
 *
 * Direction depends on which side owns the async iterator.
 * Must be sent after the owning request or response message has been exchanged.
 */
export interface PeerEventStreamMessage extends PeerMessage {
  /**
   * Message kind.
   */
  kind: 'event-stream'
  /**
   * Event payload. `data` is left as `unknown` so it can be decoded by the receiver.
   */
  json: EventMeta & {
    /**
     * Kind of event
     *
     * @default 'message'
     */
    event?: undefined | 'message' | 'error' | 'close'
    /**
     * Event data.
     */
    data?: unknown
  }
  /**
   * Event-stream messages carry no binary payload.
   */
  binary?: undefined
}

/**
 * Carries one binary chunk in an octet stream.
 *
 * Direction depends on which side owns the stream.
 * Must be sent after the owning request or response message has been exchanged.
 */
export interface PeerOctetStreamMessage extends PeerMessage {
  /**
   * Message kind.
   */
  kind: 'octet-stream'
  /**
   * Stream metadata. `close` marks the final chunk.
   *
   * @default false
   */
  json: {
    /**
     * Marks the final chunk of the stream.
     *
     * @default false
     */
    close?: boolean
  }

  /**
   * Binary chunk. Should be present even when `close` is `true`.
   */
  binary?: Uint8Array<ArrayBuffer> | Blob | undefined
}

/**
 * Tells the remote peer to stop sending octet-stream or event-stream messages.
 *
 * Sent by the side that no longer needs more stream data.
 */
export interface PeerStreamCancelMessage extends PeerMessage {
  /**
   * Message kind.
   */
  kind: 'stream/cancel'

  /**
   * Stream-cancel messages carry no JSON payload.
   */
  json?: undefined

  /**
   * Stream-cancel messages carry no binary payload.
   */
  binary?: undefined
}

/**
 * Messages a client peer may send to a server peer.
 */
export type ClientPeerSendMessage
  = | PeerRequestMessage
    | PeerCancelMessage
    | PeerEventStreamMessage
    | PeerOctetStreamMessage

/**
 * Messages a server peer may send to a client peer.
 */
export type ServerPeerSendMessage
  = | PeerResponseMessage
    | PeerCancelMessage
    | PeerOctetStreamMessage
    | PeerEventStreamMessage
    | PeerStreamCancelMessage

/**
 * Limits on incoming stream messages buffered for a single request or response body.
 *
 * The peer protocol has no flow control: the remote peer sends stream messages as fast as it can,
 * and they are buffered until the body is read. These limits bound that buffer.
 * When a message would exceed them, the request is cancelled on both sides,
 * and reading the body throws a `QueueOverflowError`.
 *
 * Messages handed straight to a pending read are never buffered, so a body that is read
 * as fast as it arrives is not affected.
 */
export interface PeerStreamBufferOptions {
  /**
   * Maximum number of event-stream or octet-stream messages buffered for a single body.
   *
   * @default Infinity
   */
  maxBufferedStreamMessages?: number | undefined

  /**
   * Maximum total byte size of octet-stream chunks buffered for a single body.
   * Event-stream messages are not measured; use `maxBufferedStreamMessages` to bound them.
   *
   * @default Infinity
   */
  maxBufferedStreamBytes?: number | undefined
}
