import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DevelopersApi, DevItem, DevSession, DevState, DevUpdate } from '../shared/developers.js'
import { DevStore, devPreferences } from './dev-store.js'
import { DevApprovals, type DevDecision } from './dev-approvals.js'
import { DevCodex, type DevUpdates } from './dev-codex.js'
import { DevClaude } from './dev-claude.js'
import { canonicalRepo, devCommit, devGitState, devWorktree } from './dev-workspace.js'
import { devAccountUsage, devExternal, devExternalRead } from './dev-catalog.js'
import { devFileReview, devUndoHunk } from './dev-review.js'

interface Running { driver: DevCodex | DevClaude; approvals: DevApprovals; changed: Map<string, DevItem>; timer?: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout>; stopping?: Promise<void> }

export class DevService {
  readonly store: DevStore
  private readonly running = new Map<string, Running>()
  private readonly configuring = new Set<string>()
  private readonly ready: Promise<void>
  readonly hooks: string
  get active(): boolean { return this.running.size > 0 }
  constructor(private readonly root: string, private readonly emit: (update: DevUpdate | null) => void) {
    this.store = new DevStore(join(root, 'state.json'))
    this.hooks = join(root, 'disabled-git-hooks')
    this.ready = Promise.all([this.store.load(), mkdir(this.hooks, { recursive: true })]).then(() => undefined)
  }
  async state(): Promise<DevState> {
    await this.ready
    return { preferences: this.store.data.preferences, repos: this.store.data.repos.filter(repo => !repo.archived), sessions: this.store.data.sessions.map(session => {
      const { items, pending, ...summary } = session
      void items; void pending
      return summary
    }) }
  }
  async preferences(patch: unknown): Promise<DevState['preferences']> {
    await this.ready
    const next = devPreferences(patch, this.store.data.preferences)
    if (!next.enabled) await this.stopAll()
    this.store.data.preferences = next
    await this.store.save(); this.emit(null)
    return next
  }
  private async enabled(): Promise<void> {
    await this.ready
    if (!this.store.data.preferences.enabled) throw new Error('Enable Developers in Settings first.')
  }
  async addRepo(path: string): Promise<DevState['repos'][number]> {
    await this.enabled()
    const canonical = await canonicalRepo(path), existing = this.store.data.repos.find(repo => repo.path === canonical)
    if (existing) { if (existing.archived) { existing.archived = false; await this.store.save(); this.emit(null) }; return existing }
    const repo = { id: randomUUID(), path: canonical, name: basename(canonical) }
    this.store.data.repos.push(repo); await this.store.save(); this.emit(null)
    return repo
  }
  async removeRepo(id: string): Promise<void> {
    await this.ready
    if (this.store.data.sessions.some(session => session.repoId === id && this.running.has(session.id))) throw new Error('Stop this repository’s tasks before removing it.')
    this.store.repo(id).archived = true
    await this.store.save(); this.emit(null)
  }
  async create(request: Parameters<DevelopersApi['devCreate']>[0]): Promise<DevSession> {
    await this.enabled()
    if (!request || typeof request.repoId !== 'string') throw new Error('Choose a repository.')
    const prefs = devPreferences({ provider: request.provider, model: request.model, effort: request.effort, mode: request.mode, isolate: request.isolate }, this.store.data.preferences)
    const repo = this.store.repo(request.repoId)
    if (prefs.mode === 'full-access' && request.fullAccessConfirmed !== true) throw new Error('Explicitly confirm full access before creating this task.')
    if (prefs.mode === 'auto-edit' && !prefs.isolate) throw new Error('Automatic edits require an isolated worktree.')
    let title = 'New task', items: DevItem[] = []
    if (request.resume) {
      if (!request.fork) throw new Error('External sessions can be continued only as a new branch to avoid modifying another client’s live session.')
      const external = (await devExternal(repo.path, prefs.provider)).find(session => session.id === request.resume)
      if (!external || external.active) throw new Error('This external session is unavailable or still active.')
      title = external.title
      items = (await devExternalRead(repo.path, prefs.provider, request.resume)).map(item => ({ ...item, id: randomUUID() }))
      items.push({ id: randomUUID(), kind: 'notice', text: 'Imported conversation snapshot. Your next message continues in a separate session; the original is unchanged.' })
    }
    const location = prefs.isolate ? await devWorktree(repo, join(this.root, 'worktrees'), this.hooks) : { cwd: await canonicalRepo(repo.path) }
    const now = Date.now()
    const session: DevSession = { id: randomUUID(), repoId: repo.id, provider: prefs.provider, model: prefs.model, effort: prefs.effort, mode: prefs.mode,
      ...location, loadProjectSettings: prefs.mode === 'full-access' && prefs.loadProjectSettings, ...(request.resume ? { runtimeId: request.resume, forkOnStart: true } : {}), title, createdAt: now, updatedAt: now, state: 'idle', items, pending: [], usage: {} }
    this.store.data.sessions.push(session); await this.store.save(); this.emit(null)
    return session
  }
  async session(id: string): Promise<DevSession> { await this.ready; return this.store.session(id) }
  async configure(id: string, change: Parameters<DevelopersApi['devConfigure']>[1]): Promise<DevSession> {
    await this.enabled()
    const session = this.store.session(id)
    if (['starting', 'running', 'waiting', 'stopping'].includes(session.state)) throw new Error('Stop or finish this task before changing its settings.')
    if (!change || typeof change !== 'object') throw new Error('Invalid task settings.')
    const prefs = devPreferences({ provider: session.provider, model: change.model, effort: change.effort, mode: change.mode }, this.store.data.preferences)
    if (prefs.mode === 'full-access' && change.fullAccessConfirmed !== true) throw new Error('Explicitly confirm full access for this task.')
    if (prefs.mode === 'auto-edit' && !session.branch) throw new Error('Branch this task into an isolated worktree before enabling automatic edits.')
    if (this.configuring.has(id)) throw new Error('Task settings are already being updated.')
    this.configuring.add(id)
    try {
      await this.stop(id)
      Object.assign(session, { model: prefs.model, effort: prefs.effort, mode: prefs.mode, loadProjectSettings: prefs.mode === 'full-access' && prefs.loadProjectSettings })
      await this.store.save(); this.emit(null)
      return session
    } finally { this.configuring.delete(id) }
  }

  async send(id: string, text: string): Promise<void> {
    await this.enabled()
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error('Enter a message of up to 100,000 characters.')
    const session = this.store.session(id)
    if (this.configuring.has(id) || this.running.get(id)?.stopping) throw new Error('Wait for this task to finish stopping or updating.')
    if (['starting', 'running', 'waiting', 'stopping'].includes(session.state)) throw new Error('Wait for this task or stop it before sending another message.')
    session.state = 'starting'; session.updatedAt = Date.now()
    if (!session.items.some(item => item.kind === 'user')) session.title = text.trim().split('\n')[0]!.slice(0, 80)
    const user: DevItem = { id: randomUUID(), kind: 'user', text: text.trim() }
    session.items.push(user)
    let runtime = this.running.get(id)
    if (runtime?.idle) { clearTimeout(runtime.idle); runtime.idle = undefined }
    try {
      if (!runtime) {
        const approvals = new DevApprovals(pending => {
          if (this.running.get(id) !== runtime || runtime?.stopping) return
          session.pending = pending
          session.state = pending.length ? 'waiting' : 'running'
          this.flush(id)
        }, {
          find: key => {
            const rule = this.store.data.rules.find(rule => rule.repoId === session.repoId && rule.provider === session.provider && rule.tool === key.tool && rule.input === key.input)
            return rule ? { decision: rule.decision } : undefined
          },
          save: (key, decision) => {
            this.store.data.rules = this.store.data.rules.filter(rule => !(rule.repoId === session.repoId && rule.provider === session.provider && rule.tool === key.tool && rule.input === key.input))
            this.store.data.rules.push({ id: randomUUID(), repoId: session.repoId, provider: session.provider, ...key, decision: decision.decision })
            void this.store.save().catch(error => this.reportSaveError(session, error))
          },
        })
        const updates: DevUpdates = {
          item: (item, append) => {
            if (this.running.get(id) !== runtime || runtime?.stopping || !item.id) return
            const existing = session.items.find(value => value.id === item.id)
            if (existing) Object.assign(existing, item, { text: (append ? existing.text + item.text : item.text).slice(-200_000) })
            else session.items.push({ ...item, text: item.text.slice(-200_000) })
            const value = existing ?? session.items.at(-1)!
            runtime!.changed.set(item.id, value)
            if (!runtime!.timer) runtime!.timer = setTimeout(() => this.flush(id), 100)
          },
          usage: value => { if (this.running.get(id) === runtime && !runtime?.stopping) { session.usage = { ...session.usage, ...value }; this.flush(id) } },
          finished: error => {
            if (this.running.get(id) !== runtime || runtime?.stopping) return
            session.state = error ? 'failed' : 'idle'; session.updatedAt = Date.now()
            for (const item of session.items) if (item.status === 'running') { item.status = error ? 'failed' : 'done'; runtime!.changed.set(item.id, item) }
            if (error && !(session.items.at(-1)?.kind === 'error' && session.items.at(-1)?.text === error)) { const item: DevItem = { id: randomUUID(), kind: 'error', text: error }; session.items.push(item); runtime!.changed.set(item.id, item) }
            this.flush(id)
            void this.store.save().catch(cause => this.reportSaveError(session, cause))
            if (runtime!.idle) clearTimeout(runtime!.idle)
            runtime!.idle = setTimeout(() => { void this.stop(id).catch(cause => this.reportSaveError(session, cause)) }, 5 * 60_000)
          },
        }
        const driver = session.provider === 'codex' ? new DevCodex(session, approvals, updates) : new DevClaude(session, approvals, updates)
        runtime = { driver, approvals, changed: new Map([[user.id, user]]) }
        this.running.set(id, runtime)
        this.flush(id)
        await driver.start(session.forkOnStart)
        if (session.provider === 'codex') session.forkOnStart = false
      } else runtime.changed.set(user.id, user)
      if (this.running.get(id) !== runtime || runtime.stopping) return
      session.state = 'running'; this.flush(id)
      await this.store.save()
      await runtime.driver.send(text.trim())
    } catch (error) {
      if (runtime && this.running.get(id) !== runtime) return
      await this.stop(id)
      session.state = 'failed'
      const item: DevItem = { id: randomUUID(), kind: 'error', text: error instanceof Error ? error.message : 'The task could not start.' }
      session.items.push(item)
      this.emit({ id, items: [item], state: session.state, pending: [], usage: session.usage })
      await this.store.save()
      throw error
    }
  }
  private reportSaveError(session: DevSession, error: unknown): void {
    const item: DevItem = { id: randomUUID(), kind: 'error', text: `Task history could not be saved: ${error instanceof Error ? error.message : 'storage error'}` }
    this.emit({ id: session.id, items: [item], state: session.state, pending: session.pending, usage: session.usage })
  }
  private flush(id: string): void {
    const runtime = this.running.get(id)
    if (!runtime) return
    if (runtime.timer) { clearTimeout(runtime.timer); runtime.timer = undefined }
    const session = this.store.session(id)
    this.emit({ id, items: [...runtime.changed.values()], state: session.state, pending: session.pending, usage: session.usage, runtimeId: session.runtimeId, title: session.title, updatedAt: session.updatedAt })
    runtime.changed.clear()
  }
  async respond(id: string, requestId: string, response: DevDecision): Promise<void> {
    await this.enabled()
    const runtime = this.running.get(id)
    if (!runtime) throw new Error('This task is no longer waiting.')
    runtime.approvals.respond(requestId, response)
  }
  async stop(id: string): Promise<void> {
    await this.ready
    const runtime = this.running.get(id), session = this.store.session(id)
    let failure: unknown
    if (runtime) {
      if (!runtime.stopping) {
        session.state = 'stopping'; session.pending = []
        this.flush(id)
        clearTimeout(runtime.timer); clearTimeout(runtime.idle)
        runtime.stopping = Promise.resolve().then(async () => { runtime.approvals.close(); await runtime.driver.stop() })
      }
      try { await runtime.stopping } catch (error) { failure = error }
      if (this.running.get(id) === runtime) this.running.delete(id)
    }
    session.state = failure ? 'failed' : 'idle'; session.pending = []
    const interrupted = session.items.filter(item => item.status === 'running')
    for (const item of interrupted) item.status = 'failed'
    this.emit({ id, items: interrupted, state: session.state, pending: [], usage: session.usage })
    await this.store.save()
    if (failure) throw failure
  }
  async stopAll(): Promise<void> { await Promise.all([...this.running.keys()].map(id => this.stop(id))) }
  async git(id: string) { await this.enabled(); return devGitState(this.store.session(id).cwd, this.hooks) }
  async fileReview(id: string, path: string) { await this.enabled(); return devFileReview(this.store.session(id).cwd, path, this.hooks) }
  async undoHunk(id: string, path: string, fingerprint: string, index: number) {
    await this.enabled()
    const session = this.store.session(id)
    if (['starting', 'running', 'waiting', 'stopping'].includes(session.state)) throw new Error('Stop the task before changing its files.')
    return devUndoHunk(session.cwd, path, fingerprint, index, this.hooks, join(this.root, 'review-backups'))
  }
  async external(repoId: string, provider: 'claude' | 'codex') {
    await this.enabled()
    if (!['claude', 'codex'].includes(provider)) throw new Error('Unknown provider.')
    return devExternal(this.store.repo(repoId).path, provider)
  }
  async externalRead(repoId: string, provider: 'claude' | 'codex', id: string) {
    await this.enabled()
    if (!['claude', 'codex'].includes(provider) || typeof id !== 'string') throw new Error('Unknown session.')
    return devExternalRead(this.store.repo(repoId).path, provider, id)
  }
  async fork(id: string): Promise<DevSession> {
    await this.enabled()
    const source = this.store.session(id)
    if (['starting', 'running', 'waiting', 'stopping'].includes(source.state)) throw new Error('Finish or stop the task before branching.')
    if (!source.runtimeId) throw new Error('Start a conversation before branching it.')
    const repo = this.store.repo(source.repoId)
    const location = await devWorktree({ ...repo, path: source.cwd }, join(this.root, 'worktrees'), this.hooks)
    const now = Date.now(), session: DevSession = { ...source, ...location, id: randomUUID(), mode: 'review', loadProjectSettings: false, createdAt: now, updatedAt: now, title: `${source.title} · branch`, state: 'idle', pending: [], forkOnStart: true, usage: {}, items: [...source.items.map(item => ({ ...item })), { id: randomUUID(), kind: 'notice', text: 'Branched conversation. This worktree starts at the source task’s current commit; uncommitted changes were not copied.' }] }
    this.store.data.sessions.push(session); await this.store.save(); this.emit(null)
    return session
  }
  async usage(provider: 'claude' | 'codex') {
    await this.ready
    if (!['claude', 'codex'].includes(provider)) throw new Error('Unknown provider.')
    if (provider === 'codex') return devAccountUsage(this.root)
    const active = [...this.running.values()].find(runtime => runtime.driver instanceof DevClaude)
    return active?.driver instanceof DevClaude ? active.driver.usage() : { unavailable: 'Start a Claude development task to see provider-reported account limits.' }
  }
  async commands(id: string) {
    await this.enabled()
    this.store.session(id)
    const runtime = this.running.get(id)
    if (!runtime) throw new Error('Send a message to connect this task before loading its skills.')
    return runtime.driver.commands()
  }
  async commit(id: string, paths: string[], message: string): Promise<void> {
    await this.enabled()
    const session = this.store.session(id)
    if (['starting', 'running', 'waiting', 'stopping'].includes(session.state)) throw new Error('Wait for the task to finish before committing.')
    await devCommit(session.cwd, paths, message, this.hooks)
  }
}
