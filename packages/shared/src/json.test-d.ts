import { stringifyJSON } from './json'

it('stringifyJSON', () => {
  expectTypeOf(stringifyJSON(undefined)).toEqualTypeOf<string | undefined>()
  expectTypeOf(stringifyJSON({})).toEqualTypeOf<string>()
  expectTypeOf(stringifyJSON({ toJSON: () => undefined })).toEqualTypeOf<undefined | string>()
})
