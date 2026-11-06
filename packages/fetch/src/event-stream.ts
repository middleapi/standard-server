import {
  encodeEventStreamMessage,
  ErrorEvent,
  EventStreamDecoderError,
  EventStreamDecoderStream,
  getEventMeta,
  unwrapEvent,
  withEventMeta,
} from '@standard-server/core'
import {
  AsyncIteratorClass,
  isTypescriptObject,
  parseEmptyableJSON,
  stringifyJSON,
} from '@standard-server/shared'

export function toAsyncIteratorObject(
  stream: ReadableStream<Uint8Array<ArrayBuffer>> | null,
): AsyncIteratorClass<unknown> {
  const eventStream = stream
    ?.pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventStreamDecoderStream())

  const reader = eventStream?.getReader()

  return new AsyncIteratorClass(
    async () => {
      while (true) {
        const result = await reader?.read()

        /**
         * A stream only completes with a 'close' or 'error' event, so ending without
         * one means it was cut off, like a stream ending with an incomplete message.
         * A read cancelled by `return()` also ends here, and AsyncIteratorClass
         * resolves it as done instead.
         */
        if (result === undefined || result.done) {
          throw new EventStreamDecoderError('Event Stream ended before complete')
        }

        const { value } = result

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
    },
    async () => {
      await reader?.cancel()
    },
  )
}

export interface ToEventStreamOptions {
  /**
   * Initial comment sent immediately upon stream start to flush headers. This allows the
   * receiving side to establish the connection without waiting for the first event.
   *
   * `false` disables it, {@link ToEventStreamInitialCommentOptions} customizes it.
   *
   * @default true
   */
  initialComment?: boolean | ToEventStreamInitialCommentOptions | undefined

  /**
   * Ping comment sent periodically to keep the connection alive.
   *
   * `false` disables it, {@link ToEventStreamKeepAliveOptions} customizes it.
   *
   * @default true
   */
  keepAlive?: boolean | ToEventStreamKeepAliveOptions | undefined
}

export interface ToEventStreamInitialCommentOptions {
  /**
   * The content of the initial comment sent upon stream start. Must not include newline characters.
   *
   * @default ''
   */
  comment?: string | undefined
}

export interface ToEventStreamKeepAliveOptions {
  /**
   * Interval (in milliseconds) between ping comments sent after the last event.
   *
   * @default 15000
   */
  interval?: number | undefined

  /**
   * The content of the ping comment. Must not include newline characters.
   *
   * @default ''
   */
  comment?: string | undefined
}

export function toEventStream(
  iterator: AsyncIterator<unknown, unknown, void>,
  options: ToEventStreamOptions = {},
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const keepAlive = typeof options.keepAlive === 'object' ? options.keepAlive : {}
  const initialComment = typeof options.initialComment === 'object' ? options.initialComment : {}

  const keepAliveEnabled = options.keepAlive !== false
  const keepAliveInterval = keepAlive.interval ?? 15000
  const keepAliveComment = keepAlive.comment ?? ''
  const initialCommentEnabled = options.initialComment !== false
  const initialCommentContent = initialComment.comment ?? ''

  let cancelled = false
  let timeout: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream<string>({
    start(controller) {
      if (initialCommentEnabled) {
        controller.enqueue(
          encodeEventStreamMessage({
            comments: [initialCommentContent],
          }),
        )
      }
    },
    async pull(controller) {
      let result: IteratorResult<unknown>

      try {
        if (keepAliveEnabled) {
          timeout = setInterval(() => {
            controller.enqueue(
              encodeEventStreamMessage({
                comments: [keepAliveComment],
              }),
            )
          }, keepAliveInterval)
        }

        result = await iterator.next()
      } catch (err) {
        clearInterval(timeout)

        if (cancelled) {
          return
        }

        if (err instanceof ErrorEvent) {
          controller.enqueue(
            encodeEventStreamMessage({
              ...getEventMeta(err),
              event: 'error',
              data: stringifyJSON(err.data),
            }),
          )
          controller.close()
        } else {
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

        controller.enqueue(
          encodeEventStreamMessage({
            ...meta,
            event: result.done ? 'close' : 'message',
            data: stringifyJSON(data),
          }),
        )
      } catch (err) {
        /**
         * The event could not be serialized (e.g. BigInt, circular data, a throwing toJSON).
         * An errored stream never calls `cancel()`, so release the suspended iterator here.
         */
        try {
          if (!result.done) {
            await iterator.return?.()
          }
        } finally {
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
