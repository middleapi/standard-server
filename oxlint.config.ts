import { defineConfig } from 'oxlint'

export default defineConfig({
  ignorePatterns: ['.agents/skills/**', '.claude/skills/**'],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  categories: {
    correctness: 'error',
    suspicious: 'error',
  },
  plugins: ['eslint', 'typescript', 'unicorn', 'oxc', 'import'],
  rules: {
    'typescript/no-unsafe-type-assertion': 'off',
    'no-underscore-dangle': 'off',

    'eqeqeq': 'error',
    'guard-for-in': 'error',
    'no-prototype-builtins': 'error',
    'no-throw-literal': 'error',
    'prefer-promise-reject-errors': 'error',
    'no-console': ['error', { allow: ['warn', 'error'] }],
    'no-var': 'error',
    'prefer-const': 'error',
    'typescript/no-import-type-side-effects': 'error',
    'unicorn/prefer-node-protocol': 'error',
    'no-restricted-properties': [
      'error',
      {
        object: 'JSON',
        property: 'stringify',
        message: 'JSON.stringify can return undefined, use stringifyJSON instead',
      },
      {
        property: 'bytes',
        message:
          'Request/Blob/Response/... .bytes is not widely supported, use readAsBuffer instead',
      },
      {
        property: 'throwIfAborted',
        message:
          "React Native's AbortSignal polyfill has no throwIfAborted, use throwIfAborted from @standard-server/shared instead",
      },
    ],
  },
  overrides: [
    {
      files: ['packages/*/src/**'],
      rules: {
        'no-restricted-globals': [
          'error',
          {
            name: 'encodeURIComponent',
            message:
              'encodeURIComponent throws on lone surrogates, use safeEncodeURIComponent from @standard-server/shared instead',
          },
          {
            name: 'decodeURIComponent',
            message:
              'decodeURIComponent throws on malformed input, use safeDecodeURIComponent from @standard-server/shared instead',
          },
        ],
      },
    },
    {
      files: ['**/*.test.ts', '**/*.test-d.ts', 'playgrounds/**'],
      rules: {
        'no-unused-vars': 'off',
        'no-restricted-properties': 'off',
        'no-console': 'off',
        'no-shadow': 'off',
        'unicorn/consistent-function-scoping': 'off',
      },
    },
  ],
})
