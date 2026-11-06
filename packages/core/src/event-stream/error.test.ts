import { EventStreamErrorEvent } from './error.ts'

it('errorEvent', () => {
  const errorEvent = new EventStreamErrorEvent('data', { cause: 'cause' })

  expect(errorEvent.message).toBe('Error Event')
  expect(errorEvent.cause).toBe('cause')
  expect(errorEvent.data).toBe('data')

  const errorEventWithCustomMessage = new EventStreamErrorEvent('data', {
    message: 'custom message',
  })
  expect(errorEventWithCustomMessage.message).toBe('custom message')
})

it('deprecated ErrorEvent alias', async () => {
  const { ErrorEvent } = await import('./error.ts')
  expect(ErrorEvent).toBe(EventStreamErrorEvent)
  expect(new ErrorEvent('data')).toBeInstanceOf(EventStreamErrorEvent)
})
