import { AbortError, PayloadTooLargeError } from './error'

it('abortError', () => {
  const error = new AbortError('Operation aborted', {
    cause: '__cause__',
  })
  expect(error.name).toBe('AbortError')
  expect(error.message).toBe('Operation aborted')
  expect(error.cause).toBe('__cause__')
})

it('payloadTooLargeError', () => {
  const error = new PayloadTooLargeError('Body is too large', {
    cause: '__cause__',
  })
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('PayloadTooLargeError')
  expect(error.message).toBe('Body is too large')
  expect(error.cause).toBe('__cause__')
  expect(error.status).toBe(413)
})
