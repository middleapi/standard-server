import { defineConfig } from 'oxfmt'

export default defineConfig({
  ignorePatterns: ['.agents/skills/**', '.claude/skills/**'],
  semi: false,
  singleQuote: true,
  quoteProps: 'consistent',
  sortImports: true,
})
