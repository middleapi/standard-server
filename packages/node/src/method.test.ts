import { toStandardMethod } from './method.ts'

it('toStandardMethod', () => {
  expect(toStandardMethod('GET')).toEqual('GET')
  expect(toStandardMethod('POST')).toEqual('POST')
  expect(toStandardMethod(undefined)).toEqual('GET')
})
