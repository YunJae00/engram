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
vi.mock('../src/main/dev-claude.js', () => ({ DevClaude: class {
  constructor(private session: { runtimeId?: string }, private approvals: { close(): void }, private updates: { item(value: unknown): void; finished(): void }) {}
  async start() { this.session.runtimeId = 'claude-fixture-session' }
  async send(text: string) { this.updates.item({ id: 'response', kind: 'assistant', text }); this.updates.finished() }
  async stop() { this.approvals.close(); this.updates.finished() }
} }))
import { DevService } from '../src/main/dev-service.js'
import { initializeAccountProfiles, addAccountProfile, selectAccountProfile } from '../src/main/account-profiles.js'

it('switches both providers in one conversation without reusing runtime IDs or overwriting messages', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-handoff-')), service = new DevService(root, vi.fn())
  const original = { ...process.env }
  try {
    await initializeAccountProfiles(root)
    await service.preferences({ enabled: true })
    const repo = await service.addRepo(root)
    const session = await service.create({ repoId: repo.id, provider: 'codex', model: '', mode: 'review', isolate: false })
    await service.send(session.id, 'Preserve the current files')
    const oldAnswer = session.items[1]!.text, cwd = session.cwd
    await service.configure(session.id, { provider: 'claude', model: '', mode: 'review' })
    expect(session.runtimeId).toBeUndefined()
    expect(session.handoff).toContain('Preserve the current files')
    expect((await service.state()).sessions[0]).not.toHaveProperty('handoff')
    const restored = new DevService(root, vi.fn())
    expect((await restored.session(session.id)).handoff).toContain('Preserve the current files')
    await service.send(session.id, 'Continue with the fix')
    expect(session.runtimeId).toBe('claude-fixture-session')
    expect(session.handoff).toBeUndefined()
    expect(session.items[1]!.text).toBe(oldAnswer)
    expect(session.items.at(-1)!.text).toContain('Current user request:\nContinue with the fix')
    await service.configure(session.id, { provider: 'codex', model: '', mode: 'plan' })
    expect(session.runtimeId).toBeUndefined()
    expect(session.handoff).toContain('Continue with the fix')
    await service.send(session.id, 'Review the result')
    expect(session.cwd).toBe(cwd)
    expect(session.mode).toBe('plan')
    expect((await service.state()).sessions).toHaveLength(1)
    session.state = 'running'
    await expect(service.configure(session.id, { provider: 'claude', model: '', mode: 'review' })).rejects.toThrow('Stop or finish')
    session.state = 'idle'
  } finally { await service.stopAll(); process.env = original }
})

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
  await expect(service.create({ ...request, resume: 'external' })).rejects.toThrow('Confirm')
  const resumed = await service.create({ ...request, resume: 'external', resumeConfirmed: true })
  expect(resumed).toMatchObject({ runtimeId: 'external', forkOnStart: false })
  expect(resumed.items).toHaveLength(2)
  expect((await service.create({ ...request, resume: 'external', resumeConfirmed: true })).id).toBe(resumed.id)
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

it('keeps existing sessions on their account when the default changes', async () => {
  const original = { ...process.env }
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-accounts-')), service = new DevService(root, vi.fn())
  try {
    await initializeAccountProfiles(root)
    await service.preferences({ enabled: true })
    const repo = await service.addRepo(root)
    const request = { repoId: repo.id, provider: 'codex' as const, model: '', mode: 'review' as const, isolate: false, resume: 'external', resumeConfirmed: true }
    const personal = await service.create(request)
    const profiles = await addAccountProfile('codex', 'Work'), workId = profiles.profiles[0]!.id
    await selectAccountProfile('codex', workId)
    const work = await service.create(request)
    expect(work.id).not.toBe(personal.id)
    expect(work.accountProfile).toBe(workId)
    expect(personal.accountProfile).toBe('system')
    await service.send(personal.id, 'Continue on the original account')
    expect((await service.session(personal.id)).accountProfile).toBe('system')
    expect(await service.configure(personal.id, { model: '', mode: 'plan' })).toMatchObject({ accountProfile: 'system', mode: 'plan' })
  } finally { await service.stopAll(); process.env = original }
})
