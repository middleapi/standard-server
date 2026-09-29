import { encodeEventStreamMessage, ErrorEvent, EventStreamDecoderStream, getEventMeta, unwrapEvent, withEventMeta } from '@standard-server/core'
import { AsyncIteratorClass, isTypescriptObject, parseEmptyableJSON, stringifyJSON } from '@standard-server/shared'

export function toAsyncIteratorObject(
  stream: ReadableStream<Uint8Array<ArrayBuffer>> | null,
): AsyncIteratorClass<unknown> {
  const eventStream = stream
    ?.pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventStreamDecoderStream())

  const reader = eventStream?.getReader()

  return new AsyncIteratorClass(async () => {
    while (true) {
      if (reader === undefined) {
        return { done: true, value: undefined }
      }

      const { done, value } = await reader.read()

      /**
       * The sender closed the stream without sending a 'close' event.
       * A read cancelled by `return()` also ends here, and AsyncIteratorClass
       * resolves it as done either way.
       */
      if (done) {
        return { done: true, value: undefined }
      }

      switch (value.event) {
        case 'message': {
          let message = parseEmptyableJSON(value.data)

          if (isTypescriptObject(message)) {
            message = withEventMeta(message, value)
          }

          return { done: false, value: message }
        }

        case 'error': {
          let error = new ErrorEvent(parseEmptyableJSON(value.data))

          error = withEventMeta(error, value)

          throw error
        }

        case 'close': {
          let close = parseEmptyableJSON(value.data)

          if (isTypescriptObject(close)) {
            close = withEventMeta(close, value)
          }

          return { done: true, value: close }
        }
      }
    }
  }, async () => {
    await reader?.cancel()
  })
}

export interface ToEventStreamOptions {
  /**
   * If enabled, an initial comment is sent immediately upon stream start to flush headers.
   * This allows the receiving side to establish the connection without waiting for the first event.
   *
   * @default { enabled: true }
   */
  initialComment?: undefined | {
    /**
     * If true, an initial comment is sent immediately upon stream start to flush headers.
     * This allows the receiving side to establish the connection without waiting for the first event.
     *
     * @default true
     */
    enabled?: boolean

    /**
     * The content of the initial comment sent upon stream start. Must not include newline characters.
     *
     * @default ''
     */
    comment?: string
  }

  /**
   * If enabled, a ping comment is sent periodically to keep the connection alive.
   *
   * @default { enabled: true }
   */
  keepAlive?: undefined | {
    /**
     * If true, a ping comment is sent periodically to keep the connection alive.
     *
     * @default true
     */
    enabled: boolean

    /**
     * Interval (in milliseconds) between ping comments sent after the last event.
     *
     * @default 15000
     */
    interval?: number

    /**
     * The content of the ping comment. Must not include newline characters.
     *
     * @default ''
     */
    comment?: string
  }

  /**
   * If true, a `close` event is sent even when the iterator completes with `undefined`.
   * When the iterator returns a value, a `close` event is always emitted regardless of this setting.
   *
   * @default true
   */
  emptyCloseEventEnabled?: boolean
}

export function toEventStream(
  iterator: AsyncIterator<unknown | void, unknown | void, void>,
  options: ToEventStreamOptions = {},
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const keepAliveEnabled = options.keepAlive?.enabled ?? true
  const keepAliveInterval = options.keepAlive?.interval ?? 15000
  const keepAliveComment = options.keepAlive?.comment ?? ''
  const initialCommentEnabled = options.initialComment?.enabled ?? true
  const initialComment = options.initialComment?.comment ?? ''
  const emptyCloseEventEnabled = options.emptyCloseEventEnabled ?? true

  let cancelled = false
  let timeout: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream<string>({
    start(controller) {
      if (initialCommentEnabled) {
        controller.enqueue(encodeEventStreamMessage({
          comments: [initialComment],
        }))
      }
    },
    async pull(controller) {
      let result: IteratorResult<unknown>

      try {
        if (keepAliveEnabled) {
          timeout = setInterval(() => {
            controller.enqueue(encodeEventStreamMessage({
              comments: [keepAliveComment],
            }))
          }, keepAliveInterval)
        }

        result = await iterator.next()
      }
      catch (err) {
        clearInterval(timeout)

        if (cancelled) {
          return
        }

        if (err instanceof ErrorEvent) {
          controller.enqueue(encodeEventStreamMessage({
            ...getEventMeta(err),
            event: 'error',
            data: stringifyJSON(err.data),
          }))
          controller.close()
        }
        else {
          /**
           * Should treat a non-ErrorEvent as an error.
           */
          controller.error(err)
        }

        return
      }

      clearInterval(timeout)

      if (cancelled) {
        return
      }

      try {
        const [data, meta] = unwrapEvent(result.value)

        if (!result.done || data !== undefined || meta !== undefined || emptyCloseEventEnabled) {
          const event = result.done ? 'close' : 'message'
          controller.enqueue(encodeEventStreamMessage({
            ...meta,
            event,
            data: stringifyJSON(data),
          }))
        }
      }
      catch (err) {
        /**
         * The event could not be serialized (e.g. BigInt, circular data, a throwing toJSON).
         * An errored stream never calls `cancel()`, so release the suspended iterator here.
         */
        try {
          if (!result.done) {
            await iterator.return?.()
          }
        }
        finally {
          controller.error(err)
        }

        return
      }

      if (result.done) {
        controller.close()
      }
    },
    async cancel() {
      cancelled = true
      clearInterval(timeout)

      await iterator.return?.()
    },
  }).pipeThrough(new TextEncoderStream())

  return stream
}
