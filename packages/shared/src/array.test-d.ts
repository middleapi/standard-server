import { toArray } from './array'

it('toArray', () => {
  expectTypeOf(toArray(undefined)).toEqualTypeOf<never>()
  expectTypeOf(toArray(null)).toEqualTypeOf<never>()

  expectTypeOf(toArray(1)).toEqualTypeOf<number[]>()
  expectTypeOf(toArray({} as string[] | string)).toEqualTypeOf<string[]>()
  expectTypeOf(
    toArray({} as readonly string[] | string[] | string | null | undefined),
  ).toEqualTypeOf<readonly string[] | string[]>()
})
