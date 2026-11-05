import { ErrorEvent } from './error.ts'

it('errorEvent', () => {
  const errorEvent = new ErrorEvent('data', { cause: 'cause' })

  expect(errorEvent.message).toBe('Error Event')
  expect(errorEvent.cause).toBe('cause')
  expect(errorEvent.data).toBe('data')

  const errorEventWithCustomMessage = new ErrorEvent('data', { message: 'custom message' })
  expect(errorEventWithCustomMessage.message).toBe('custom message')
})
