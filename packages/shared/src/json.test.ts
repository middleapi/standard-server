import { parseEmptyableJSON, stringifyJSON } from './json'

it('parseEmptyableJSON', () => {
  expect(parseEmptyableJSON(undefined)).toBeUndefined()
  expect(parseEmptyableJSON(null)).toBeUndefined()
  expect(parseEmptyableJSON('')).toBeUndefined()
  expect(parseEmptyableJSON('{}')).toEqual({})
  expect(parseEmptyableJSON('{"foo":"bar"}')).toEqual({ foo: 'bar' })
})

it('stringifyJSON', () => {
  expect(stringifyJSON(undefined)).toBeUndefined()
  expect(stringifyJSON({ toJSON: () => undefined })).toBeUndefined()
  expect(stringifyJSON({})).toEqual('{}')
  expect(stringifyJSON({ foo: 'bar' })).toEqual('{"foo":"bar"}')
})
