import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameWithRetry, REASONING_EFFORTS } from 'core'
import type { DevPreferences, DevRepo, DevRule, DevSession } from '../shared/developers.js'

export const DEV_DEFAULTS: DevPreferences = { enabled: false, provider: 'codex', model: '', mode: 'review', isolate: true, loadProjectSettings: false }
export function devPreferences(value: unknown, before = DEV_DEFAULTS): DevPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid developer preferences.')
  const patch = value as Record<string, unknown>
  if (Object.keys(patch).some(key => !['enabled', 'provider', 'model', 'effort', 'mode', 'isolate', 'loadProjectSettings'].includes(key))) throw new Error('Unknown developer preference.')
  const next = { ...before, ...patch } as DevPreferences
  if (typeof next.enabled !== 'boolean' || typeof next.isolate !== 'boolean' || typeof next.loadProjectSettings !== 'boolean'
    || !['claude', 'codex'].includes(next.provider) || !['review', 'plan', 'auto-edit', 'full-access'].includes(next.mode)
    || typeof next.model !== 'string' || next.model.length > 200 || (next.effort !== undefined && !REASONING_EFFORTS.includes(next.effort))) throw new Error('Invalid developer preferences.')
  return next
}

interface Saved { preferences: DevPreferences; repos: DevRepo[]; sessions: DevSession[]; rules: DevRule[] }
export class DevStore {
  readonly data: Saved = { preferences: { ...DEV_DEFAULTS }, repos: [], sessions: [], rules: [] }
  private writing = Promise.resolve()
  private queued?: Promise<void>
  constructor(readonly file: string) {}
  async load(): Promise<void> {
    let text: string
    try { text = await readFile(this.file, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const saved = JSON.parse(text) as Saved
    if (!saved || !Array.isArray(saved.repos) || !Array.isArray(saved.sessions) || !Array.isArray(saved.rules)) throw new Error('Developer settings could not be read. The original file was preserved.')
    this.data.preferences = devPreferences(saved.preferences)
    this.data.repos = saved.repos.filter(repo => typeof repo.id === 'string' && typeof repo.path === 'string' && typeof repo.name === 'string')
    this.data.rules = saved.rules.filter(rule => ['allow', 'deny'].includes(rule.decision) && typeof rule.input === 'string' && typeof rule.repoId === 'string')
    this.data.sessions = saved.sessions.filter(session => typeof session.id === 'string' && typeof session.cwd === 'string' && Array.isArray(session.items)).map(session => ({
      ...session, state: session.state === 'failed' ? 'failed' : 'idle', pending: [],
      items: [...session.items.map(item => item.status === 'running' ? { ...item, status: 'failed' as const } : item), ...(['starting', 'running', 'waiting', 'stopping'].includes(session.state) ? [{ id: randomUUID(), kind: 'notice' as const, text: 'The app closed while this task was active. Review the working tree before continuing.' }] : [])],
    }))
  }
  save(): Promise<void> {
    if (this.queued) return this.queued
    const write = async () => {
      this.queued = undefined
      // ponytail: one full snapshot per write; split storage if individual snapshots become too costly.
      const text = JSON.stringify({ ...this.data, sessions: this.data.sessions.map(session => ({ ...session, pending: [] })) })
      await mkdir(dirname(this.file), { recursive: true })
      const pending = `${this.file}.${randomUUID()}.tmp`
      try { await writeFile(pending, text, { mode: 0o600 }); await renameWithRetry(pending, this.file) }
      finally { await rm(pending, { force: true }) }
    }
    const result = this.writing.then(write)
    this.queued = result
    this.writing = result.catch(() => undefined)
    return result
  }
  session(id: string): DevSession {
    const session = this.data.sessions.find(session => session.id === id)
    if (!session) throw new Error('Development task not found.')
    return session
  }
  repo(id: string): DevRepo {
    const repo = this.data.repos.find(repo => repo.id === id)
    if (!repo) throw new Error('Repository not found.')
    return repo
  }
}
