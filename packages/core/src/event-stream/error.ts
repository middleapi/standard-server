export class EventStreamEncoderError extends TypeError {}
export class EventStreamDecoderError extends TypeError {}

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
