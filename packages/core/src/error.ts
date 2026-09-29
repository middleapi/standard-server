/**
 * Thrown when parsing a body that is larger than the allowed `maxBodySize`.
 */
export class StandardBodyTooLargeError extends Error {
  constructor(
    public readonly maxBodySize: number,
  ) {
    super(`Body exceeds the maximum size of ${maxBodySize} bytes`)
    this.name = 'StandardBodyTooLargeError'
  }
}
