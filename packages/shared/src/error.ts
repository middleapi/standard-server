/**
 * Error thrown when an operation is aborted.
 * Uses the standardized 'AbortError' name for consistency with JavaScript APIs.
 */
export class AbortError extends Error {
  constructor(...rest: ConstructorParameters<typeof Error>) {
    super(...rest)
    this.name = 'AbortError'
  }
}

/**
 * Error thrown when a body is larger than the allowed size.
 * Its `status` is 413, which frameworks like Fastify and Express use as the response status.
 */
export class PayloadTooLargeError extends Error {
  readonly status = 413

  constructor(...rest: ConstructorParameters<typeof Error>) {
    super(...rest)
    this.name = 'PayloadTooLargeError'
  }
}
