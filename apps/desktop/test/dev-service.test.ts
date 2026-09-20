import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('../src/main/dev-catalog.js', () => ({ devAccountUsage: async () => ({ unavailable: 'Fixture' }), devExternal: async () => [{ id: 'external', title: 'Existing conversation' }, { id: 'live', active: true }], devExternalRead: async () => [{ id: 'original-user', kind: 'user', text: 'Earlier question' }, { id: 'original-answer', kind: 'assistant', text: 'Earlier answer' }] }))
vi.mock('../src/main/dev-workspace.js', () => ({ canonicalRepo: async (path: string) => resolve(path), devWorktree: async () => ({ cwd: resolve('tmp/fixture-isolated'), branch: 'fixture' }), devGitState: async () => ({ files: [], diff: '', branch: 'fixture', truncated: false }), devCommit: vi.fn() }))
vi.mock('../src/main/dev-codex.js', () => ({ DevCodex: class {
  constructor(private session: { runtimeId?: string }, private approvals: { close(): void }, private updates: { item(value: unknown): void; finished(): void }) {}
  async start() { this.session.runtimeId = 'fixture-session' }
  async send(text: string) { this.updates.item({ id: 'response', kind: 'assistant', text }); this.updates.finished() }
  async stop() { this.approvals.close(); this.updates.finished() }
} }))
vi.mock('../src/main/dev-claude.js', () => ({ DevClaude: class {} }))
import { DevService } from '../src/main/dev-service.js'

it('keeps developer opt-in separate, persists tasks and enforces full-access confirmation', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-service-')), events = vi.fn(), service = new DevService(root, events)
  expect((await service.state()).preferences.enabled).toBe(false)
  await expect(service.addRepo(root)).rejects.toThrow('Enable Developers')
  await service.preferences({ enabled: true })
  const repo = await service.addRepo(root)
  expect(await service.addRepo(root)).toEqual(repo)
  const request = { repoId: repo.id, provider: 'codex' as const, model: '', mode: 'review' as const, isolate: false }
  await expect(service.create({ ...request, mode: 'full-access' })).rejects.toThrow('confirm')
  await expect(service.create({ ...request, mode: 'auto-edit' })).rejects.toThrow('worktree')
  await service.preferences({ loadProjectSettings: true })
  const session = await service.create(request)
  const imported = await service.create({ ...request, resume: 'external', fork: true })
  expect(imported).toMatchObject({ title: 'Existing conversation', runtimeId: 'external', forkOnStart: true })
  expect(imported.items.map(item => item.text)).toEqual(['Earlier question', 'Earlier answer', expect.stringContaining('original is unchanged')])
  expect(imported.items[0]!.id).not.toBe('original-user')
  await expect(service.create({ ...request, resume: 'live', fork: true })).rejects.toThrow('still active')
  expect(session.loadProjectSettings).toBe(false)
  await service.send(session.id, 'Inspect the fixture')
  expect((await service.session(session.id)).items.map(item => item.text)).toEqual(['Inspect the fixture', 'Inspect the fixture'])
  expect((await service.state()).sessions[0]).not.toHaveProperty('items')
  const branch = await service.fork(session.id)
  expect(branch).toMatchObject({ runtimeId: 'fixture-session', forkOnStart: true, mode: 'review', cwd: resolve('tmp/fixture-isolated') })
  expect(branch.id).not.toBe(session.id)
  expect(branch.items.at(-1)?.text).toContain('uncommitted changes were not copied')
  branch.items[0]!.text = 'Branch only'
  expect((await service.session(session.id)).items[0]!.text).toBe('Inspect the fixture')
  await expect(service.configure(session.id, { model: '', mode: 'full-access' })).rejects.toThrow('confirm')
  await expect(service.configure(session.id, { model: '', mode: 'auto-edit' })).rejects.toThrow('worktree')
  expect(await service.configure(session.id, { model: '', mode: 'plan' })).toMatchObject({ mode: 'plan', loadProjectSettings: false })
  await service.preferences({ enabled: false })
  expect(service.active).toBe(false)
  await service.removeRepo(repo.id)
  expect((await service.state()).repos).toHaveLength(0)
  await service.preferences({ enabled: true })
  expect((await service.addRepo(root)).id).toBe(repo.id)
  expect((await service.state()).repos).toHaveLength(1)
  const restored = new DevService(root, vi.fn())
  expect((await restored.session(session.id)).items).toHaveLength(2)
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ id: session.id, state: 'idle' }))
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ id: session.id, title: 'Inspect the fixture' }))
  expect((await restored.session(imported.id)).items[1]?.text).toBe('Earlier answer')
})
