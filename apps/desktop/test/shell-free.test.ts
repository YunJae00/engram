import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const DESKTOP = resolve(__dirname, '..')
const PACKAGES = resolve(DESKTOP, '../../packages')
const SHELL = 'electron'
const TOOL_KIT = [
  'src/main/tool-kit.ts',
  'src/main/agent-courier.ts',
  'src/main/agent-browser.ts',
  'src/main/file-work.ts',
  'src/main/learning-wiring.ts',
  'src/main/office-agent.ts',
  'src/main/agent-profile.ts',
  'src/main/available-memory.ts',
  'src/main/browser-lanes.ts',
  'src/main/browser-window-page.ts',
  'src/main/deck-render.ts',
  'src/main/doc-render.ts',
  'src/main/file-move.ts',
  'src/main/memory-plan.ts',
  'src/main/native-browser.ts',
  'src/main/office-output.ts',
  'src/main/page-actions.ts',
  'src/main/page-downloads.ts',
  'src/main/page-frame-room.ts',
  'src/main/page-listeners.ts',
  'src/main/page-mask.ts',
  'src/main/page-preview.ts',
  'src/main/page-reader.ts',
  'src/main/page-ready.ts',
  'src/main/page-reveal.ts',
  'src/main/page-scroll.ts',
  'src/main/page-target.ts',
  'src/main/page-wall.ts',
  'src/main/plain-page.ts',
  'src/main/preview-pool.ts',
  'src/main/process-client.ts',
  'src/main/read-card.ts',
  'src/main/routine-driver.ts',
  'src/main/serial-work.ts',
  'src/main/stalled-scripts.ts',
]

function runtimeImports(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) if (!match[1]) found.push(match[2]!)
  for (const match of source.matchAll(/\bimport\(\s*(?:\/\*[^*]*\*\/\s*)?['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]!)
  return found
}

function resolved(from: string, spec: string): string | null {
  if (spec === 'core') return join(PACKAGES, 'core/src/index.ts')
  if (spec.startsWith('core/')) return join(PACKAGES, `${spec}.ts`)
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  for (const file of [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base, `${base}.ts`, join(base, 'index.ts')]) if (existsSync(file) && file.match(/\.[mc]?[jt]sx?$/)) return file
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

describe('the tool kit and the files it builds from', () => {
  it.each(TOOL_KIT)('%s never reaches the shell through its imports', file => {
    expect(shellPath(file)).toBeNull()
  })
})

describe('the model engine and the files it builds from', () => {
  it.each(['src/main/engine-claude.ts', 'src/main/engine-claude-session.ts', 'src/main/engine-claude-voice.ts', 'src/main/run-text.ts', 'src/main/usage-limit.ts'])('%s never reaches the shell through its imports', file => {
    expect(shellPath(file)).toBeNull()
  })
})

describe('the headless runner and its one answer entry', () => {
  it.each(['src/main/answer.ts', 'src/main/first-line.ts', 'src/main/fast-lane.ts', 'src/main/runner.ts', 'scripts/runner.mts'])('%s never reaches the shell through its imports', file => {
    expect(shellPath(file)).toBeNull()
  })
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
