import { readFile } from 'node:fs/promises'

it('readme never flattens set-cookie', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const calls = [...readme.matchAll(/```[\s\S]*?```/g)].flatMap(
    ([block]) => block.match(/flattenStandardHeader\([^)]*\)/g) ?? [],
  )

  expect(calls.length).toBeGreaterThan(0)
  expect(calls.filter((call) => /set-cookie/i.test(call))).toEqual([])
})
