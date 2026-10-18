export class EventStreamEncoderError extends TypeError {}
export class EventStreamDecoderError extends TypeError {}

/**
 * Thrown when an event stream ends without a `close` event. `toEventStream` always sends one
 * when the iterator finishes, so the stream was cut short, e.g. by a proxy idle timeout,
 * a serverless time limit, or a dropped connection.
 */
export class EventStreamIncompleteError extends EventStreamDecoderError {}

export interface ErrorEventOptions extends ErrorOptions {
  message?: string
}

export class ErrorEvent extends Error {
  constructor(
    public data: unknown,
    options: ErrorEventOptions = {},
  ) {
    super(options?.message ?? 'Error Event', options)
  }
}
