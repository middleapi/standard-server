import { hasAnyDefinedValue, isNonPrimitive } from './object.ts'

it('hasAnyDefinedValue', () => {
  expect(hasAnyDefinedValue({})).toBe(false)
  expect(hasAnyDefinedValue({ 'content-type': undefined, 'standard-server': undefined })).toBe(
    false,
  )

  expect(hasAnyDefinedValue({ 'content-type': undefined, 'x-custom': 'yes' })).toBe(true)
  expect(hasAnyDefinedValue({ 'set-cookie': ['a=1'] })).toBe(true)
})

it('isNonPrimitive', () => {
  expect(isNonPrimitive(null)).toBe(false)
  expect(isNonPrimitive(undefined)).toBe(false)
  expect(isNonPrimitive(123)).toBe(false)
  expect(isNonPrimitive('string')).toBe(false)

  expect(isNonPrimitive({})).toBe(true)
  expect(isNonPrimitive(new Date())).toBe(true)
  expect(isNonPrimitive(() => {})).toBe(true)
})

it('deprecated isTypescriptObject alias', async () => {
  const { isTypescriptObject } = await import('./object.ts')
  expect(isTypescriptObject).toBe(isNonPrimitive)
})
