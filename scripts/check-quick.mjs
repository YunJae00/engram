import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = (script, args = []) => {
  const started = performance.now()
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', windowsHide: true })
  console.log(`${script}: ${((performance.now() - started) / 1000).toFixed(1)}s`)
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log('Development feedback only; run npm run check and npm run test:e2e before release.')
run('node_modules/typescript/bin/tsc', ['-p', 'packages/core', '--noEmit'])
run('node_modules/typescript/bin/tsc', ['-p', 'apps/desktop', '--noEmit'])
run('node_modules/eslint/bin/eslint.js', ['.', '--cache', '--cache-strategy', 'content', '--cache-location', 'tmp/eslint.cache'])
const tests = process.argv.slice(2)
run('node_modules/vitest/vitest.mjs', ['run', '--project', 'unit', ...(tests.length ? tests : ['--changed', 'origin/main', '--passWithNoTests'])])
run('scripts/todo-scan.mjs')
run('scripts/css-orphan-scan.mjs')
