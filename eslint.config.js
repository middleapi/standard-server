import antfu from '@antfu/eslint-config'
import pluginBan from 'eslint-plugin-ban'

export default antfu({
  formatters: true,
  rules: {
    'yaml/sort-keys': 'off',
    'pnpm/json-enforce-catalog': 'off',
    'pnpm/yaml-enforce-settings': 'off',
    'ts/method-signature-style': 'off',
    'guard-for-in': 'error',
  },
}, {
  plugins: { ban: pluginBan },
  rules: {
    'ban/ban': [
      'error',
      {
        name: ['JSON', 'stringify'],
        message: 'JSON.stringify can return undefined, use stringifyJSON instead',
      },
      {
        name: ['*', 'bytes'],
        message: 'Request/Blob/Response/... .bytes is not widely supported, use readAsBuffer instead',
      },
    ],
  },
}, {
  files: ['packages/*/src/**'],
  rules: {
    // a scoped block replaces the base rule rather than extending it,
    // so the first two names repeat what @antfu/eslint-config already bans
    'no-restricted-globals': ['error', {
      name: 'global',
      message: 'Use `globalThis` instead.',
    }, {
      name: 'self',
      message: 'Use `globalThis` instead.',
    }, {
      name: 'encodeURIComponent',
      message: 'encodeURIComponent throws on lone surrogates, use safeEncodeURIComponent from @standard-server/shared instead',
    }, {
      name: 'decodeURIComponent',
      message: 'decodeURIComponent throws on malformed input, use safeDecodeURIComponent from @standard-server/shared instead',
    }],
  },
}, {
  files: ['**/*.test.ts', '**/*.test.tsx', '**/*.test-d.ts', '**/*.test-d.tsx', 'playgrounds/**', 'packages/*/playground/**'],
  rules: {
    'unused-imports/no-unused-vars': 'off',
    'antfu/no-top-level-await': 'off',
    'no-alert': 'off',
    'ban/ban': 'off',
    'no-restricted-globals': 'off',
    'no-console': 'off',
  },
})
