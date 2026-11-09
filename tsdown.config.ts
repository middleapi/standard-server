import { readFileSync } from 'node:fs'

import { defineConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  exports: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export default defineConfig({
  entry: Object.values(pkg.exports).filter((path) => path.startsWith('./src/')),
  unbundle: true,
  deps: {
    neverBundle: true,
    onlyImport: [...Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }), /^node:/],
  },
  platform: 'neutral',
  target: 'es2022',
  dts: { generator: 'oxc' },
})
