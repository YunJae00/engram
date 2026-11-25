import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'

const DESKTOP = resolve(__dirname, '..')
const PACKAGES = resolve(DESKTOP, '../../packages')
const SHELL = 'electron'

function runtimeImports(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) if (!match[1]) found.push(match[2]!)
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]!)
  return found
}

function resolved(from: string, spec: string): string | null {
  if (spec === 'core') return join(PACKAGES, 'core/src/index.ts')
  if (spec.startsWith('core/')) return join(PACKAGES, `${spec}.ts`)
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  for (const file of [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, join(base, 'index.ts')]) if (existsSync(file)) return file
  return null
}

function shellPath(entry: string): string[] | null {
  const seen = new Set<string>()
  const walk = (file: string, trail: string[]): string[] | null => {
    if (seen.has(file)) return null
    seen.add(file)
    for (const spec of runtimeImports(readFileSync(file, 'utf8'))) {
      if (spec === SHELL) return [...trail, file]
      const next = resolved(file, spec)
      const path = next && walk(next, [...trail, file])
      if (path) return path
    }
    return null
  }
  return walk(resolve(DESKTOP, entry), [])
}

it('keeps the log module free of the desktop shell', () => {
  expect(shellPath('src/main/flog.ts')).toBeNull()
})

it('keeps the worker pool free of the desktop shell', () => {
  expect(shellPath('src/main/worker-pool.ts')).toBeNull()
})

it('keeps the tool schema builder free of the desktop shell', () => {
  expect(shellPath('src/main/engine-claude-tools.ts')).toBeNull()
})

it('keeps the model call trace free of the desktop shell', () => {
  expect(shellPath('../../packages/core/src/engine/trace.ts')).toBeNull()
})

it('reports a file that still reaches the shell', () => {
  expect(shellPath('src/main/engine-cloud.ts')?.length).toBeGreaterThan(1)
})

const scratch = resolve(DESKTOP, '../../tmp/shell-free-fixture')
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const write = (files: Record<string, string>): void => {
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(scratch, name), text)
}

it('finds a shell import that sits two steps down a chain', () => {
  write({
    'lantern.ts': "import { wick } from './wick.js'\nexport const glow = wick\n",
    'wick.ts': "import { flint } from './flint.js'\nexport const wick = flint\n",
    'flint.ts': "import {\n  app,\n} from 'electron'\nexport const flint = app\n",
  })
  expect(shellPath(join(scratch, 'lantern.ts'))?.map(file => file.slice(scratch.length + 1))).toEqual(['lantern.ts', 'wick.ts', 'flint.ts'])
})

it('counts a lazy import of the shell and ignores an import used only for types', () => {
  write({
    'compass.ts': "import type { App } from 'electron'\nexport type North = App\n",
    'sail.ts': "export const hoist = () => import('electron')\n",
  })
  expect(shellPath(join(scratch, 'compass.ts'))).toBeNull()
  expect(shellPath(join(scratch, 'sail.ts'))).not.toBeNull()
})
