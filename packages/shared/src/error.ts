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
 * Error thrown when a body is larger than its size limit.
 * Its `status` is 413, which frameworks like Fastify and Express use as the response status.
 */
export class PayloadTooLargeError extends Error {
  readonly status = 413

  /**
   * The size limit the body exceeds, in bytes.
   */
  readonly limit: number

  constructor(limit: number, options?: ErrorOptions) {
    super(`Body exceeds the size limit of ${limit} bytes`, options)
    this.name = 'PayloadTooLargeError'
    this.limit = limit
  }
}
