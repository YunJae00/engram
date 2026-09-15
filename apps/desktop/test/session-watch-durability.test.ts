import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { VaultContext } from '../src/main/vault.js'

const state = vi.hoisted(() => ({ root: '', fail: true, prompts: [] as string[] }))
vi.mock('node:os', () => ({ homedir: () => state.root }))
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => state.root }, ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/ipc.js', () => ({ LIBRARIAN_RUN_OPTS: {}, noteRunOutcome: vi.fn(), runPipelineAsync: vi.fn() }))
vi.mock('core', async importOriginal => ({
  ...await importOriginal<typeof import('core')>(), readAgentsMd: async () => '',
  JobRunner: class {
    async runAll(jobs: { prompt: string }[]) {
      state.prompts.push(jobs[0].prompt)
      return { executed: state.fail ? 0 : 1, skipped: 0, deferred: state.fail ? 1 : 0, failed: [] }
    }
  },
}))
afterEach(async () => { vi.useRealTimers(); if (state.root) await rm(state.root, { recursive: true, force: true }) })

it('keeps a failed backlog through restart, applies backpressure, then drains oldest-first without new writes', async () => {
  state.root = await mkdtemp(resolve('tmp/session-watch-'))
  state.fail = true
  state.prompts = []
  const dir = join(state.root, '.claude', 'projects', 'work')
  const cache = join(state.root, 'cache')
  await mkdir(dir, { recursive: true }); await mkdir(cache)
  const file = join(dir, 'session.jsonl')
  const checkpoint = join(cache, 'session-cursors.json')
  const rows = Array.from({ length: 125 }, (_, i) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `Finding ${i}.` }, timestamp: '2026-09-15T00:00:00Z' }) + '\n').join('')
  await writeFile(file, rows)
  await writeFile(checkpoint, JSON.stringify({ [file]: { offset: 0, kept: [] } }))
  await writeFile(join(state.root, 'session-watch.json'), '{"enabled":true}')
  const ctx = { paths: { cache, workspace: join(state.root, 'vault'), privateDir: join(state.root, 'private') }, engines: [{}] } as VaultContext
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let watcher = await import('../src/main/session-watch.js')
  await watcher.startSessionWatch(ctx)
  await vi.waitFor(async () => expect(JSON.parse(await readFile(checkpoint, 'utf8'))[file].held).toHaveLength(125))
  watcher.stopSessionWatch()
  await appendFile(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Later finding.' } }) + '\n')
  await watcher.scanSessions(ctx)
  expect(JSON.parse(await readFile(checkpoint, 'utf8'))[file].held).toHaveLength(125)
  vi.resetModules()
  watcher = await import('../src/main/session-watch.js')
  state.fail = false
  await watcher.startSessionWatch(ctx)
  await vi.waitFor(async () => expect(JSON.parse(await readFile(checkpoint, 'utf8'))[file].held).toHaveLength(85))
  watcher.stopSessionWatch()
  await watcher.scanSessions(ctx)
  await watcher.scanSessions(ctx)
  const remaining = JSON.parse(await readFile(checkpoint, 'utf8'))[file].held
  expect(remaining.map((turn: { text: string }) => turn.text)).toEqual(Array.from({ length: 5 }, (_, i) => `Finding ${120 + i}.`))
  expect(state.prompts.at(-1)).toContain('Finding 80.')
  expect(state.prompts.at(-1)).not.toContain('Finding 120.')
})
