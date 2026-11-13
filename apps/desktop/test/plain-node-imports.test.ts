import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

// The desktop fixtures (scripts/test-desktop-*.mjs, run by CI's owned-fixture job) import main-process .ts files
// with plain node and no bundler, so those files must not import other src files: './x.js' does not resolve to x.ts there.
it('loads every src file a desktop fixture script imports with plain node', () => {
  const scripts = fileURLToPath(new URL('../scripts/', import.meta.url))
  const files = new Set<string>()
  for (const name of readdirSync(scripts).filter(one => one.endsWith('.mjs')))
    for (const match of readFileSync(scripts + name, 'utf8').matchAll(/from '(\.\.\/src\/[^']+\.ts)'/g)) files.add(new URL(match[1]!, new URL(`file://${scripts}`)).href)
  expect(files.size).toBeGreaterThan(0)
  for (const file of files) execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(file)})`], { stdio: 'pipe' })
}, 30_000)
