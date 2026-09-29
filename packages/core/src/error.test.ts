import { StandardBodyTooLargeError } from './error'

it('standardBodyTooLargeError', () => {
  const error = new StandardBodyTooLargeError(1024)

  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('StandardBodyTooLargeError')
  expect(error.message).toBe('Body exceeds the maximum size of 1024 bytes')
  expect(error.maxBodySize).toBe(1024)
})
