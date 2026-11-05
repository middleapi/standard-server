import * as index from './index.ts'

it('export something', () => {
  expect(Object.keys(index).length).toBeGreaterThan(0)
})
