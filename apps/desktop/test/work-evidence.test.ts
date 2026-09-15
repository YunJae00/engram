import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { saveArtifact, vaultPaths } from 'core'

const state = vi.hoisted(() => ({ root: '', page: {} as Record<string, unknown>, approve: vi.fn(), input: vi.fn(), screenshot: vi.fn(), close: vi.fn(), url: 'https://example.test/issue', existing: false }))
vi.mock('electron', () => ({ app: {}, dialog: { showMessageBox: state.approve }, shell: { openPath: vi.fn() } }))
vi.mock('../src/main/agent-browser.js', () => ({ agentPage: async () => state.page, readAgentPage: vi.fn() }))
vi.mock('../src/main/file-work.js', () => ({ artifactDirectory: () => state.root }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/evidence-video.js', () => ({ videoEncoder: async () => ({ frame: async () => {}, finish: async () => Buffer.from('1a45dfa300000000', 'hex'), close: state.close }) }))
import { workEvidenceTools, evidenceStatus, stopEvidenceRecording } from '../src/main/work-evidence.js'

beforeEach(async () => {
  await mkdir('tmp', { recursive: true }); state.root = await mkdtemp(resolve('tmp/evidence-host-'))
  state.url = 'https://example.test/issue'; state.existing = false
  state.close.mockReset(); state.input.mockReset(); state.screenshot.mockReset(); state.approve.mockReset().mockResolvedValue({ response: 2 })
  const input = { count: async () => 1, evaluate: async () => true, setInputFiles: state.input }
  const receipt = { filter: () => receipt, count: async () => Number(state.existing), first: () => receipt, waitFor: async () => {} }
  const frame = { getByLabel: () => ({ and: () => input }), locator: (selector: string) => ({ count: async () => selector === '#missing' ? 0 : 1 }), url: () => state.url, isDetached: () => false }
  state.page = { url: () => state.url, frames: () => [frame], isClosed: () => false, screenshot: state.screenshot, getByText: () => receipt, once: vi.fn(), off: vi.fn() }
})
afterEach(async () => { await rm(state.root, { recursive: true, force: true }) })
const tool = (name: string) => workEvidenceTools(vaultPaths(state.root), 'test').find(tool => tool.name === name)!
const context = { task: 'Attach reviewed evidence' }
async function upload() {
  const artifact = await saveArtifact(state.root, 'evidence.txt', Buffer.from('Owned evidence'))
  return { artifact, args: { artifact: artifact.artifact, url: state.url, target: 'Attachment', confirmation: 'Saved attachment' } }
}

it('never selects a file after denial and does not reprompt through the same tool set', async () => {
  const { args } = await upload(); const target = tool('upload_file')
  state.approve.mockResolvedValue({ response: 0 })
  await expect(target.run(args, context)).rejects.toThrow('declined')
  await expect(target.run(args, context)).rejects.toThrow('declined')
  expect(state.input).not.toHaveBeenCalled(); expect(state.approve).toHaveBeenCalledTimes(1)
})

it.each(['navigation', 'tampering', 'cancellation'])('rechecks %s after the approval dialog and sends no bytes', async kind => {
  const { args, artifact } = await upload(); const controller = new AbortController()
  state.approve.mockImplementation(async () => {
    if (kind === 'navigation') state.url = 'https://other.test/'
    if (kind === 'tampering') await writeFile(artifact.path, 'changed')
    if (kind === 'cancellation') controller.abort()
    return { response: 2 }
  })
  await expect(tool('upload_file').run(args, { ...context, signal: controller.signal })).rejects.toThrow()
  expect(state.input).not.toHaveBeenCalled()
})

it('uploads the approved immutable bytes to a labeled input and rejects an existing confirmation', async () => {
  const { args } = await upload()
  expect(JSON.parse(await tool('upload_file').run(args, context)).upload.status).toBe('confirmed')
  expect(state.input.mock.calls[0]![0].buffer.toString()).toBe('Owned evidence')
  state.existing = true
  await expect(tool('upload_file').run(args, context)).rejects.toThrow('duplicate')
  expect(state.input).toHaveBeenCalledTimes(1)
})

it('fails closed when a requested redaction target disappears', async () => {
  state.approve.mockResolvedValue({ response: 1 })
  await expect(tool('capture_evidence').run({ name: 'before', url: state.url, masks: ['#missing'] }, context)).rejects.toThrow('redaction target')
  expect(state.screenshot).not.toHaveBeenCalled()
})

it('saves an interrupted recording on cancellation, clears its status and stops taking frames', async () => {
  state.approve.mockResolvedValue({ response: 1 })
  state.screenshot.mockResolvedValue(Buffer.from('89504e470d0a1a0a', 'hex'))
  const controller = new AbortController()
  expect(JSON.parse(await tool('record_start').run({ name: 'before', url: state.url, masks: [] }, { ...context, signal: controller.signal })).recording).toBe('started')
  expect(evidenceStatus('test')).not.toBeNull()
  controller.abort()
  expect(await stopEvidenceRecording('test')).toMatchObject({ recording: 'interrupted', frames: 1 })
  expect(evidenceStatus('test')).toBeNull(); expect(state.close).toHaveBeenCalledOnce()
  const frames = state.screenshot.mock.calls.length
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(state.screenshot).toHaveBeenCalledTimes(frames)
})
