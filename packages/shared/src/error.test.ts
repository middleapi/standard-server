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
  const error = new PayloadTooLargeError(1024, {
    cause: '__cause__',
  })
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('PayloadTooLargeError')
  expect(error.message).toBe('Body exceeds the size limit of 1024 bytes')
  expect(error.cause).toBe('__cause__')
  expect(error.status).toBe(413)
  expect(error.limit).toBe(1024)
})
