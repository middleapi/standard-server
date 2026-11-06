export class EventStreamEncoderError extends TypeError {}
export class EventStreamDecoderError extends TypeError {}

export interface EventStreamErrorEventOptions extends ErrorOptions {
  message?: string | undefined
}

export class EventStreamErrorEvent extends Error {
  constructor(
    public data: unknown,
    options: EventStreamErrorEventOptions = {},
  ) {
    super(options.message ?? 'Error Event', options)
  }
}

/**
 * @deprecated Use {@link EventStreamErrorEventOptions} instead.
 */
export interface ErrorEventOptions extends EventStreamErrorEventOptions {}

/**
 * @deprecated Use {@link EventStreamErrorEvent} instead. `ErrorEvent` shadows the global `ErrorEvent`.
 */
export const ErrorEvent: typeof EventStreamErrorEvent = EventStreamErrorEvent

/**
 * @deprecated Use {@link EventStreamErrorEvent} instead. `ErrorEvent` shadows the global `ErrorEvent`.
 */
export type ErrorEvent = EventStreamErrorEvent
