import { hasAnyDefinedValue, isTypescriptObject } from './object'

it('hasAnyDefinedValue', () => {
  expect(hasAnyDefinedValue({})).toBe(false)
  expect(hasAnyDefinedValue({ 'content-type': undefined, 'standard-server': undefined })).toBe(
    false,
  )

  expect(hasAnyDefinedValue({ 'content-type': undefined, 'x-custom': 'yes' })).toBe(true)
  expect(hasAnyDefinedValue({ 'set-cookie': ['a=1'] })).toBe(true)
})

it('isTypescriptObject', () => {
  expect(isTypescriptObject(null)).toBe(false)
  expect(isTypescriptObject(undefined)).toBe(false)
  expect(isTypescriptObject(123)).toBe(false)
  expect(isTypescriptObject('string')).toBe(false)

  expect(isTypescriptObject({})).toBe(true)
  expect(isTypescriptObject(new Date())).toBe(true)
  expect(isTypescriptObject(() => {})).toBe(true)
})
