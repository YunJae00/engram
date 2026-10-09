import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readArtifact, saveArtifact, vaultPaths } from 'core'

const state = vi.hoisted(() => ({ root: '', page: {} as Record<string, unknown>, approve: vi.fn(), input: vi.fn(), screenshot: vi.fn(), url: 'https://example.test/issue', existing: false }))
vi.mock('electron', () => ({ app: {}, nativeImage: {}, dialog: { showMessageBox: state.approve }, shell: { openPath: vi.fn() } }))
vi.mock('../src/main/agent-browser.js', () => ({ agentPage: async () => state.page, readAgentPage: vi.fn() }))
vi.mock('../src/main/file-work.js', () => ({ artifactDirectory: () => state.root }))
import { workEvidenceTools } from '../src/main/work-evidence.js'

beforeEach(async () => {
  await mkdir('tmp', { recursive: true }); state.root = await mkdtemp(resolve('tmp/evidence-host-'))
  state.url = 'https://example.test/issue'; state.existing = false
  state.input.mockReset(); state.screenshot.mockReset(); state.approve.mockReset().mockResolvedValue({ response: 2 })
  const input = { count: async () => 1, evaluate: async () => true, setInputFiles: state.input }
  const receipt = { filter: () => receipt, count: async () => Number(state.existing), first: () => receipt, waitFor: async () => {} }
  const frame = { getByLabel: () => ({ and: () => input }), locator: (selector: string) => ({ count: async () => selector === '#missing' ? 0 : 1 }), url: () => state.url, isDetached: () => false }
  state.page = { url: () => state.url, frames: () => [frame], isClosed: () => false, screenshot: state.screenshot, getByText: () => receipt, on: vi.fn(), once: vi.fn(), off: vi.fn() }
})
afterEach(async () => { await rm(state.root, { recursive: true, force: true }) })
const tool = (name: string) => workEvidenceTools(vaultPaths(state.root), 'test').find(tool => tool.name === name)!
const context = { task: 'Attach reviewed evidence' }
async function upload(name = 'evidence.txt') {
  const media = /\.(mp4|webm)$/.test(name)
  const data = name.endsWith('.mp4') ? Buffer.from('000000186674797069736f6d', 'hex') : name.endsWith('.webm') ? Buffer.from('1a45dfa300000000', 'hex') : Buffer.from('Owned evidence')
  const artifact = await saveArtifact(state.root, name, data, undefined, media)
  return { artifact, data, args: { artifact: artifact.artifact, url: state.url, target: 'Attachment', confirmation: 'Saved attachment' } }
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

it.each(['evidence.txt', 'EVIDENCE.TXT', 'existing.mp4', 'existing.webm'])('uploads approved immutable bytes from %s and rejects an existing confirmation', async name => {
  const { args, data } = await upload(name)
  expect(JSON.parse(await tool('upload_file').run(args, context)).upload.status).toBe('confirmed')
  expect(state.input.mock.calls[0]![0].buffer).toEqual(data)
  state.existing = true
  await expect(tool('upload_file').run(args, context)).rejects.toThrow('duplicate')
  expect(state.input).toHaveBeenCalledTimes(1)
})

it('fails closed when a requested redaction target disappears', async () => {
  state.approve.mockResolvedValue({ response: 1 })
  await expect(tool('capture_evidence').run({ name: 'before', url: state.url, masks: ['#missing'] }, context)).rejects.toThrow('redaction target')
  expect(state.screenshot).not.toHaveBeenCalled()
})

it('offers screenshots and verification without video tools', () => {
  expect(workEvidenceTools(vaultPaths(state.root), 'test').map(tool => tool.name)).toEqual(['wait_for', 'verify', 'capture_evidence', 'upload_file'])
})

it('saves one approved masked screenshot and its provenance without starting a recording', async () => {
  state.approve.mockResolvedValue({ response: 1 })
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  state.screenshot.mockResolvedValue(png)
  const result = JSON.parse(await tool('capture_evidence').run({ name: 'before', url: state.url, masks: ['#private'] }, context))
  expect(await readArtifact(state.root, result.artifact)).toEqual(png)
  expect(result.provenance).toContain('engram-artifact:')
  expect(state.approve).toHaveBeenCalledOnce()
  expect(state.screenshot).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'png', mask: expect.any(Array) }))
  expect(state.screenshot.mock.calls[0]![0].mask).toHaveLength(2)
  await expect(tool('capture_evidence').run({ name: '../invalid', url: state.url }, context)).rejects.toThrow('plain evidence name')
})

it('does not take a screenshot after approval is declined', async () => {
  state.approve.mockResolvedValue({ response: 0 })
  await expect(tool('capture_evidence').run({ name: 'before', url: state.url }, context)).rejects.toThrow('declined')
  expect(state.screenshot).not.toHaveBeenCalled()
})
