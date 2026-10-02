import { defineConfig } from 'oxlint'
import { middleapi } from 'uncheck/oxlint'

export default defineConfig({
  extends: [middleapi],
  rules: {
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
      files: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.test-d.ts',
        '**/*.test-d.tsx',
        'playgrounds/**',
        'packages/*/playground/**',
      ],
      rules: {
        'no-unused-vars': 'off',
        'no-restricted-properties': 'off',
        'no-restricted-globals': 'off',
        'no-console': 'off',
      },
    },
  ],
})
