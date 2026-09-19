import { test, expect } from '@playwright/test'
import { Worker } from 'node:worker_threads'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function request(entry: string, workerData: unknown): Promise<{ result?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`../out/main/${entry}.js`, import.meta.url), { workerData })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', () => reject(new Error('Worker exited without replying')))
  })
}

test('built backup worker initializes, commits and reads status without losing edits', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'e2e-backup-worker-'))
  const bin = fileURLToPath(new URL('../bundle/', import.meta.url))
  expect((await request('vault-git-worker', { task: 'init', root, bin })).error).toBeUndefined()
  await writeFile(join(root, 'workspace', 'worker-check.txt'), 'Saved outside the window thread.\n')
  const saved = await request('vault-git-worker', { task: 'commit', root, bin, message: 'test: save a note' })
  expect(saved.error).toBeUndefined()
  expect(saved.result).toEqual(expect.any(String))
  expect((await request('vault-git-worker', { task: 'commit', root, bin, message: 'test: unchanged' })).result).toBeNull()
  expect((await request('vault-git-worker', { task: 'status', root, bin })).result).toEqual({ state: 'no-remote', ahead: 0, behind: 0 })
})

test('built model worker reports a missing runtime instead of leaving a pending request', async () => {
  const missing = fileURLToPath(new URL('../../../tmp/absent-test-runtime', import.meta.url))
  const reply = await request('codex-worker', { options: { codexPathOverride: missing }, thread: { skipGitRepoCheck: true }, input: 'Unused fixture input' })
  expect(reply.error).toContain('ENOENT')
})
