import codspeedPlugin from '@codspeed/vitest-plugin'
import { defaultExclude, defineConfig } from 'vitest/config'

export default defineConfig(() => ({
  plugins: [codspeedPlugin()],
  test: {
    globals: true,
    include: ['**/*.test.ts'],
    exclude: [...defaultExclude, '**/.claude/**', './tests/bun/**', './tests/deno/**'],
    // exposes Node's EventSource global, which is still behind a flag (Node 20 - 26)
    execArgv: ['--experimental-eventsource'],
    coverage: {
      include: ['packages/*/src/**'],
      exclude: ['**.test-d.*', '**.test.*', '**/*.bench.ts', './tests/bun/**', './tests/deno/**'],
    },
    benchmark: {
      include: ['**/*.bench.ts'],
      exclude: [...defaultExclude, '**/.claude/**'],
    },
  },
}))
