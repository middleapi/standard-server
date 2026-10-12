import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT_DIR = join(import.meta.dirname, '..')

/**
 * Source files that end up in the published builds, relative to the repo root.
 */
function listSourceFiles(): string[] {
  return readdirSync(join(ROOT_DIR, 'packages')).flatMap((pkg) => {
    const srcDir = join('packages', pkg, 'src')

    return readdirSync(join(ROOT_DIR, srcDir), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !/\.(?:test|test-d|bench)\.ts$/.test(file))
      .map((file) => join(srcDir, file))
  })
}

// unbuild does not down-level regex syntax, and a regex literal Safari can't parse
// (lookbehind before 16.4) is a SyntaxError that stops the whole module from loading
it('published source has no regex lookbehind', () => {
  const files = listSourceFiles()
  expect(files).toContain(join('packages', 'shared', 'src', 'uri.ts'))

  const matches = files.filter((file) =>
    /\(\?<[=!]/.test(readFileSync(join(ROOT_DIR, file), 'utf8')),
  )
  expect(matches).toEqual([])
})
