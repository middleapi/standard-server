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
      {
        name: 'decodeURIComponent',
        message: 'decodeURIComponent can throw an error, use tryDecodeURIComponent instead',
      },
    ],
  },
}, {
  files: ['**/*.test.ts', '**/*.test.tsx', '**/*.test-d.ts', '**/*.test-d.tsx', 'playgrounds/**', 'packages/*/playground/**'],
  rules: {
    'unused-imports/no-unused-vars': 'off',
    'antfu/no-top-level-await': 'off',
    'no-alert': 'off',
    'ban/ban': 'off',
    'no-console': 'off',
  },
})
