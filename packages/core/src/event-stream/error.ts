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
