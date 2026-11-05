import { toArray } from './array.ts'

it('toArray', () => {
  expect(toArray(undefined)).toEqual([])
  expect(toArray(null)).toEqual([])
  expect(toArray(1)).toEqual([1])
  expect(toArray([1])).toEqual([1])
})
