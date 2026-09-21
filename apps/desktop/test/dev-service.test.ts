import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

const runtimeFixture = vi.hoisted(() => ({ starts: 0, failNext: false, hold: false, stopError: false, sent: [] as string[] }))

vi.mock('../src/main/dev-catalog.js', () => ({ devAccountUsage: async () => ({ unavailable: 'Fixture' }), devExternal: async () => [{ id: 'external', title: 'Existing conversation' }, { id: 'live', active: true }], devExternalRead: async () => [{ id: 'original-user', kind: 'user', text: 'Earlier question' }, { id: 'original-answer', kind: 'assistant', text: 'Earlier answer' }] }))
vi.mock('../src/main/dev-workspace.js', () => ({ canonicalRepo: async (path: string) => resolve(path), devWorktree: async () => ({ cwd: resolve('tmp/fixture-isolated'), branch: 'fixture' }), devGitState: async () => ({ files: [], diff: '', branch: 'fixture', truncated: false }), devCommit: vi.fn() }))
vi.mock('../src/main/dev-codex.js', () => ({ DevCodex: class {
  constructor(private session: { runtimeId?: string }, private approvals: { close(): void }, private updates: { item(value: unknown): void; finished(error?: string): void }) {}
  async start() { runtimeFixture.starts++; this.session.runtimeId = 'fixture-session' }
  async send(text: string) {
    runtimeFixture.sent.push(text)
    if (runtimeFixture.failNext) { runtimeFixture.failNext = false; this.updates.finished('Connection closed'); return }
    this.updates.item({ id: 'response', kind: 'assistant', text, status: 'running' }); if (!runtimeFixture.hold) this.updates.finished()
  }
  async stop() { this.approvals.close(); this.updates.finished(); if (runtimeFixture.stopError) { runtimeFixture.stopError = false; throw new Error('Fixture cleanup failed') } }
} }))
vi.mock('../src/main/dev-claude.js', () => ({ DevClaude: class {
  constructor(private session: { runtimeId?: string }, private approvals: { close(): void }, private updates: { item(value: unknown): void; finished(): void }) {}
  async start() { this.session.runtimeId = 'claude-fixture-session' }
  async send(text: string) { this.updates.item({ id: 'response', kind: 'assistant', text }); this.updates.finished() }
  async stop() { this.approvals.close(); this.updates.finished() }
} }))
import { DevService } from '../src/main/dev-service.js'
import * as workspace from '../src/main/dev-workspace.js'
import { initializeAccountProfiles, addAccountProfile, selectAccountProfile } from '../src/main/account-profiles.js'

it('awaits pending workspace writes before shutdown and blocks new work during shutdown', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-write-shutdown-')), service = new DevService(root, vi.fn())
  await service.preferences({ enabled: true })
  const repo = await service.addRepo(root)
  const task = await service.create({ repoId: repo.id, provider: 'codex', model: '', mode: 'review', isolate: false })
  let release!: () => void, settled = false
  const pending = new Promise<void>(resolve => { release = resolve })
  const commit = vi.mocked(workspace.devCommit).mockImplementationOnce(() => pending)
  const writing = service.commit(task.id, ['sample.ts'], 'Update fixture')
  await vi.waitFor(() => expect(commit).toHaveBeenCalled())
  expect(service.active).toBe(true); expect(service.busy).toBe(true)
  const stopping = service.stopAll().then(() => { settled = true })
  try {
    await expect(service.send(task.id, 'Do not start')).rejects.toThrow('finish stopping')
    expect(settled).toBe(false)
    release(); await writing; await stopping
    expect(service.active).toBe(false); expect(service.busy).toBe(false)
  } finally { release(); await writing; await stopping }
})

it('scopes file access to the chosen workspace and blocks saves while any same-folder task runs', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-file-service-')), service = new DevService(root, vi.fn())
  await initializeAccountProfiles(root)
  await service.preferences({ enabled: true })
  const repo = await service.addRepo(root), otherRoot = await mkdtemp(resolve('tmp/dev-other-project-')), other = await service.addRepo(otherRoot)
  await writeFile(resolve(root, 'sample.ts'), 'original')
  const task = await service.create({ repoId: repo.id, provider: 'codex', model: '', mode: 'review', isolate: false })
  const context = { repoId: repo.id, sessionId: task.id }
  const file = await service.readFile(context, 'sample.ts')
  await expect(service.readFile({ repoId: other.id, sessionId: task.id }, 'sample.ts')).rejects.toThrow('different project')
  task.state = 'running'
  await expect(service.saveFile({ repoId: repo.id }, file.path, file.fingerprint, 'modified')).rejects.toThrow('Stop workspace tasks')
  task.state = 'idle'
  expect((await service.saveFile(context, file.path, file.fingerprint, 'modified')).text).toBe('modified')
  await service.preferences({ enabled: false })
  await expect(service.files(context, '')).rejects.toThrow('Enable Developers')
})

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
  const shared = await service.fork(session.id, false)
  expect(shared.cwd).toBe(session.cwd)
  expect(shared.items.at(-1)?.text).toContain('Files are shared')
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

it('retains disconnected history and reconnects only on the next user message without replay', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-reconnect-')), service = new DevService(root, vi.fn())
  try {
    await service.preferences({ enabled: true })
    const repo = await service.addRepo(root)
    const session = await service.create({ repoId: repo.id, provider: 'codex', model: '', mode: 'review', isolate: false })
    const before = runtimeFixture.starts
    runtimeFixture.sent = []; runtimeFixture.failNext = true
    await service.send(session.id, 'First command')
    expect(session.state).toBe('failed')
    expect(runtimeFixture.starts).toBe(before + 1)
    expect(runtimeFixture.sent).toEqual(['First command'])
    await service.send(session.id, 'Inspect what completed before continuing')
    expect(runtimeFixture.starts).toBe(before + 2)
    expect(runtimeFixture.sent).toEqual(['First command', 'Inspect what completed before continuing'])
    expect(session.runtimeId).toBe('fixture-session')
    expect(session.items.filter(item => item.kind === 'user')).toHaveLength(2)
    expect(session.items.some(item => item.text.includes('history could not be saved'))).toBe(false)
  } finally { await service.stopAll() }
  const restored = new DevService(root, vi.fn())
  expect((await restored.session((await service.state()).sessions[0]!.id)).items.some(item => item.text === 'Connection closed')).toBe(true)
})

it('does not label runtime cleanup failures as lost history', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-cleanup-')), events = vi.fn(), service = new DevService(root, events)
  await service.preferences({ enabled: true })
  const repo = await service.addRepo(root)
  const session = await service.create({ repoId: repo.id, provider: 'codex', model: '', mode: 'review', isolate: false })
  try {
    await service.send(session.id, 'Keep this conversation')
    runtimeFixture.stopError = true
    await expect(service.stop(session.id)).rejects.toThrow('Fixture cleanup failed')
    const updates = JSON.stringify(events.mock.calls)
    expect(updates).toContain('could not close cleanly')
    expect(updates).not.toContain('Task history could not be saved')
    const restored = new DevService(root, vi.fn())
    expect((await restored.session(session.id)).items[0]?.text).toBe('Keep this conversation')
  } finally { runtimeFixture.stopError = false; await service.stopAll() }
})

it('checkpoints partial responses before a long turn completes', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-checkpoint-')), service = new DevService(root, vi.fn())
  try {
    await service.preferences({ enabled: true })
    const repo = await service.addRepo(root)
    const session = await service.create({ repoId: repo.id, provider: 'codex', model: '', mode: 'review', isolate: false })
    runtimeFixture.hold = true
    await service.send(session.id, 'Partial response')
    const save = vi.spyOn(service.store, 'save')
    await vi.waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 8000, interval: 100 })
    await save.mock.results[0]!.value
    const restored = new DevService(root, vi.fn())
    expect((await restored.session(session.id)).items).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'Partial response', status: 'failed' }))
  } finally { runtimeFixture.hold = false; await service.stopAll() }
}, 15_000)

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

it('does not dispatch a turn stopped while its history checkpoint is pending', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-stop-save-')), service = new DevService(root, vi.fn())
  await service.preferences({ enabled: true })
  const repo = await service.addRepo(root)
  const session = await service.create({ repoId: repo.id, provider: 'codex', model: '', mode: 'review', isolate: false })
  let release!: () => void
  const checkpoint = new Promise<void>(resolve => { release = resolve })
  const save = vi.spyOn(service.store, 'save').mockImplementationOnce(() => checkpoint)
  runtimeFixture.sent = []
  try {
    const sending = service.send(session.id, 'Do not execute after stop')
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    await service.stop(session.id)
    release(); await sending
    expect(runtimeFixture.sent).toEqual([])
    expect(session.state).toBe('idle')
  } finally { release(); save.mockRestore(); await service.stopAll() }
})

it('waits for every task to finish stopping even when one cleanup fails', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-stop-all-')), service = new DevService(root, vi.fn())
  await service.preferences({ enabled: true })
  const repo = await service.addRepo(root)
  const request = { repoId: repo.id, provider: 'codex' as const, model: '', mode: 'review' as const, isolate: false }
  const first = await service.create(request), second = await service.create(request)
  await service.send(first.id, 'First task'); await service.send(second.id, 'Second task')
  let release!: () => void, failed = false, settled = false
  const pending = new Promise<void>(resolve => { release = resolve })
  const originalStop = service.stop.bind(service)
  const stop = vi.spyOn(service, 'stop').mockImplementation(async id => {
    if (id === second.id) await pending
    await originalStop(id)
    if (id === first.id) { failed = true; throw new Error('Fixture cleanup failed') }
  })
  const result = service.stopAll().then(() => { settled = true; return undefined }, error => { settled = true; return error })
  try {
    await vi.waitFor(() => expect(failed).toBe(true))
    expect(settled).toBe(false)
    release()
    expect(await result).toBeInstanceOf(Error)
    expect(service.active).toBe(false)
    const restored = new DevService(root, vi.fn())
    expect((await restored.session(second.id)).items[0]?.text).toBe('Second task')
  } finally { release(); await result; stop.mockRestore(); await service.stopAll() }
})

it('blocks new turns as soon as Developers is disabled, before cleanup finishes', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-disable-')), service = new DevService(root, vi.fn())
  await service.preferences({ enabled: true })
  const repo = await service.addRepo(root)
  const session = await service.create({ repoId: repo.id, provider: 'codex', model: '', mode: 'review', isolate: false })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const stopAll = vi.spyOn(service, 'stopAll').mockImplementationOnce(() => pending)
  const disabling = service.preferences({ enabled: false })
  try {
    await vi.waitFor(() => expect(stopAll).toHaveBeenCalled())
    await expect(service.send(session.id, 'Must not start')).rejects.toThrow('Enable Developers')
    release(); await disabling
    expect(service.active).toBe(false)
    await service.preferences({ enabled: true })
    stopAll.mockRejectedValueOnce(new Error('Fixture cleanup failed'))
    await expect(service.preferences({ enabled: false })).rejects.toThrow('Fixture cleanup failed')
    const restored = new DevService(root, vi.fn())
    expect((await restored.state()).preferences.enabled).toBe(false)
  } finally { release(); await disabling; stopAll.mockRestore(); await service.stopAll() }
})

it('keeps a branch source stable while its folder is being prepared', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-fork-race-')), service = new DevService(root, vi.fn())
  await service.preferences({ enabled: true })
  const repo = await service.addRepo(root)
  const source = await service.create({ repoId: repo.id, provider: 'codex', model: '', mode: 'review', isolate: false })
  await service.send(source.id, 'Original conversation')
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const folder = vi.spyOn(workspace, 'canonicalRepo').mockImplementationOnce(async path => { await pending; return resolve(path) })
  const branching = service.fork(source.id, false)
  try {
    await vi.waitFor(() => expect(folder).toHaveBeenCalled())
    await expect(service.configure(source.id, { provider: 'claude', model: '', mode: 'review' })).rejects.toThrow('already being updated')
    await expect(service.send(source.id, 'Concurrent turn')).rejects.toThrow('updating')
    await expect(service.fork(source.id, false)).rejects.toThrow('already being updated')
    release()
    const branch = await branching
    expect(branch.provider).toBe('codex')
    expect(branch.runtimeId).toBe('fixture-session')
    expect(branch.items.filter(item => item.kind === 'user')).toHaveLength(1)
  } finally { release(); await branching; folder.mockRestore(); await service.stopAll() }
})
