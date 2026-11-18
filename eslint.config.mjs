import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '.claude/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'apps/desktop/bundle/**',
      'apps/desktop/native-bin/**',
      'tmp/**',
      'fixtures/**',
      'coverage/**',
      '.ds-sync/**',
      'ds-bundle/**',
      '.design-sync/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }] } },
  {
    files: ['**/scripts/**/*.{mjs,ts}', '**/bin/**/*.mjs', '**/*.config.{js,mjs,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['scripts/verify-scenarios/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['apps/desktop/native/macos/Office.js'],
    languageOptions: { globals: { ObjC: 'readonly', Application: 'readonly', Path: 'readonly', $: 'readonly' } },
    rules: { 'no-control-regex': 'off' },
  },
)
