import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))

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

describe('published source', () => {
  it('lists the source files', () => {
    expect(listSourceFiles()).toContain(join('packages', 'shared', 'src', 'uri.ts'))
    expect(listSourceFiles()).not.toContain(join('packages', 'shared', 'src', 'uri.test.ts'))
  })

  // unbuild does not down-level regex syntax, and a regex literal Safari can't parse
  // (lookbehind before 16.4) is a SyntaxError that stops the whole module from loading
  it('has no regex lookbehind', () => {
    const matches = listSourceFiles().flatMap((file) =>
      readFileSync(join(ROOT_DIR, file), 'utf8')
        .split('\n')
        .flatMap((line, index) => (/\(\?<[=!]/.test(line) ? [`${file}:${index + 1}`] : [])),
    )

    expect(matches).toEqual([])
  })
})
