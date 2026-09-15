import { expect, it, vi } from 'vitest'
import { checkPage, evidenceFault, evidenceTools } from '../src/work-evidence.js'
import { readArtifact, saveArtifact, resolveArtifact } from '../src/file-work.js'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AgentLoopStep } from '../src/agent-loop.js'
import { routineTask } from '../src/routine-task.js'
import { pickTools } from '../src/agent-prompt.js'

const page = { url: 'https://example.test/app', title: 'App', text: 'Ready Saved', links: [] }
const check = { id: 'save', url: page.url, ready: 'Ready', present: ['Saved'], absent: ['Failed'] }
const step = (tool: string, observation: object, args = {}): AgentLoopStep => ({ tool, args, observation: JSON.stringify(observation) })

it('retains fresh check criteria and web scope without saving reusable upload artifact ids', () => {
  const task = routineTask('Verify a fix and attach evidence', [step('verify', { verification: { status: 'passed' } }, check), step('upload_file', { upload: { status: 'confirmed' } }, { artifact: 'old-private-id', url: page.url, target: 'File' })])
  expect(task.surface).toBe('web'); expect(task.urls).toContain(page.url)
  expect(task.checks?.[0]).toContain('Ready'); expect(JSON.stringify(task)).not.toContain('old-private-id')
  const host = { read: vi.fn(), start: vi.fn(), stop: vi.fn(), capture: vi.fn(), upload: vi.fn() }
  const tools = [...['open_page', 'read_open_page', 'press'].map(name => ({ name, description: name, argsSchema: {}, run: vi.fn() })), ...evidenceTools(host)]
  const menu = pickTools(tools, 'Record reproduction evidence', [step('open_page', { url: page.url })]).map(tool => tool.name)
  expect(menu).toContain('open_page'); expect(menu).toContain('press'); expect(menu).toContain('record_start')
})

it('requires the expected URL and positive readiness, and never infers absence from truncated text', () => {
  expect(checkPage(page, check).status).toBe('passed')
  expect(checkPage({ ...page, text: 'Loading' }, check).status).toBe('inconclusive')
  expect(checkPage({ ...page, url: 'https://example.test/login' }, check).status).toBe('inconclusive')
  expect(checkPage({ ...page, text: 'Ready Failed' }, check).status).toBe('failed')
  expect(checkPage({ ...page, text: 'Ready Saved [Page extract truncated;' }, check).status).toBe('inconclusive')
})

it('waits for a fresh successful read and stops on cancellation', async () => {
  const read = vi.fn().mockResolvedValueOnce({ ...page, text: 'Loading' }).mockResolvedValue(page)
  const tools = evidenceTools({ read, start: vi.fn(), stop: vi.fn(), capture: vi.fn(), upload: vi.fn() })
  expect(JSON.parse(await tools[0]!.run({ ...check, timeoutMs: 1000 }, { task: 'Wait' })).verification.status).toBe('passed')
  expect(read).toHaveBeenCalledTimes(2)
  const controller = new AbortController(); controller.abort()
  await expect(tools[0]!.run(check, { task: 'Wait', signal: controller.signal })).rejects.toThrow()
})

it('keeps failed checks, interrupted recordings and uncertain uploads unverified', () => {
  const failed = step('verify', { verification: { status: 'failed' } }, check)
  const passed = step('verify', { verification: { status: 'passed' } }, check)
  expect(evidenceFault([failed, { ...passed, args: { ...check, ready: 'Other' } }])).toBeDefined()
  expect(evidenceFault([failed, { ...passed, seeded: true }])).toBeDefined()
  expect(evidenceFault([failed, passed])).toBeUndefined()
  const started = step('record_start', { recording: 'started' }, { name: 'before', url: page.url })
  expect(evidenceFault([started, step('record_stop', { recording: 'interrupted' })])).toBeDefined()
  const saved = { recording: 'saved', name: 'before', url: page.url, artifact: 'before.webm', frames: 1 }
  expect(evidenceFault([started, step('record_stop', saved)])).toBeUndefined()
  expect(evidenceFault([started, step('record_stop', { ...saved, frames: 0 })])).toBeDefined()
  expect(evidenceFault([step('upload_file', { upload: { status: 'unconfirmed' } })])).toBeDefined()
})

it('keeps before and after recordings independent and accepts only matching fresh completion receipts', () => {
  const start = (name: string, url = page.url) => step('record_start', { recording: 'started' }, { name, url })
  const stop = (name: string) => step('record_stop', { recording: 'saved', name, url: page.url, artifact: `${name}.webm`, frames: 2 })
  const steps = [start('before'), step('record_stop', { recording: 'interrupted' }), start('after'), stop('after')]
  expect(evidenceFault(steps)).toBeDefined()
  expect(evidenceFault([...steps, start('before'), stop('before')])).toBeUndefined()
  expect(evidenceFault([start('before', 'https://example.test:443/app'), stop('before')])).toBeUndefined()
})

it('saves media with content identity and rejects changed evidence and invalid media', async () => {
  await mkdir('tmp', { recursive: true })
  const root = await mkdtemp(resolve('tmp/evidence-artifacts-'))
  try {
    const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
    const artifact = await saveArtifact(root, 'before.png', png, undefined, true)
    expect(await readArtifact(root, artifact.artifact)).toEqual(png)
    expect(await readArtifact(root, artifact.link)).toEqual(png)
    expect(await resolveArtifact(root, artifact.link)).toBe(artifact.path)
    await expect(readArtifact(root, 'engram-artifact:..%2Foutside.png')).rejects.toThrow()
    await writeFile(await resolveArtifact(root, artifact.artifact), Buffer.from('changed'))
    await expect(readArtifact(root, artifact.artifact)).rejects.toThrow()
    await expect(saveArtifact(root, 'invalid.webm', png, undefined, true)).rejects.toThrow()
    await expect(saveArtifact(root, '../outside.png', png, undefined, true)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
