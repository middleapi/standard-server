import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const githubDir = fileURLToPath(new URL('../.github/', import.meta.url))
const workflowsDir = join(githubDir, 'workflows')

const workflows = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, content: readFileSync(join(workflowsDir, name), 'utf8') }))

/**
 * Collects every `uses:` reference across all workflows, with its version comment if any.
 */
function collectUses(): { location: string; ref: string; comment: string | undefined }[] {
  return workflows.flatMap(({ name, content }) =>
    content.split('\n').flatMap((line, index) => {
      const match = /^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"]+)\1(?:\s+#\s*(.*?))?\s*$/.exec(line)
      return match ? [{ location: `${name}:${index + 1}`, ref: match[2]!, comment: match[3] }] : []
    }),
  )
}

describe('github workflows', () => {
  it('pins every third-party action to a full commit SHA with a version comment', () => {
    const uses = collectUses().filter(({ ref }) => !ref.startsWith('./'))
    expect(uses.length).toBeGreaterThan(0)

    const unpinned = uses
      .filter(
        ({ ref, comment }) =>
          !/@[0-9a-f]{40}$/.test(ref) || !/^v\d+\.\d+\.\d+$/.test(comment ?? ''),
      )
      .map(
        ({ location, ref, comment }) =>
          `${location}: ${ref}${comment === undefined ? '' : ` # ${comment}`}`,
      )
    expect(unpinned).toEqual([])
  })

  it('keeps action pins updated through dependabot', () => {
    expect(readFileSync(join(githubDir, 'dependabot.yml'), 'utf8')).toMatch(
      /^\s*-\s+package-ecosystem:\s*github-actions\s*$/m,
    )
  })

  it('gates the release job behind an environment and the main branch', () => {
    const release = readFileSync(join(workflowsDir, 'release.yaml'), 'utf8')
    expect(release).toMatch(/^\s+environment:\s*npm-release\s*$/m)
    expect(release).toMatch(/^\s+if:\s*github\.ref\s*==\s*'refs\/heads\/main'\s*$/m)
  })

  it('does not hand a write token to EndBug/add-and-commit', () => {
    expect(
      workflows
        .filter(({ content }) => content.includes('EndBug/add-and-commit'))
        .map(({ name }) => name),
    ).toEqual([])
  })
})
