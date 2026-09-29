export interface EventMeta {
  /**
   * Event identifier, sent back by the client as `lastEventId` for reconnection attempts.
   *
   * @warning id cannot contain carriage return (`\r`), newline (`\n`) or NULL (`\0`) characters
   */
  id?: string | undefined

  /**
   * The number of milliseconds the client should wait before attempting to reconnect.
   */
  retry?: number | undefined

  /**
   * Comments associated with the event.
   *
   * @warning Comments must not contain newline characters (`\n`).
   */
  comments?: string[] | undefined
}

export interface EventStreamMessage extends EventMeta {
  /**
   * Event name (e.g., `message`, `error`).
   *
   * `message` is the default for a message with data: the encoder omits it there,
   * and the decoder fills it in.
   */
  event?: string | undefined

  /**
   * Event data, typically JSON-encoded.
   */
  data?: string | undefined
}
