import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      // agent worktrees (subagent checkouts live under .claude/worktrees)
      '.claude/**',
      '**/test-results/**',
      '**/playwright-report/**',
      // generated binary bundle (MinGit + the esbuild'd MCP server)
      'apps/desktop/bundle/**',
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
  {
    files: ['**/scripts/**/*.{mjs,ts}', '**/bin/**/*.mjs', '**/*.config.{js,mjs,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
