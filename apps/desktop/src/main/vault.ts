import type { EngineStatusDto } from '../shared/types.js'
import {
  BundledBinaryProvider,
  createEngine,
  initVault,
  MockEngine,
  NoteStore,
  type BinaryProvider,
  type Engine,
  type EngineId,
  type VaultPaths, ENGINE_ORDER, keepsEngine, mergeWorkspace, resetBotsToV2 } from 'core'
import { loadSettings } from './settings.js'
import { aiSelection, withModel } from './ai-selection.js'
import { app } from 'electron'
import { join } from 'node:path'
import { currentWorkspaceRoot, registerWorkspace, workspacesToMerge } from './workspaces.js'
import { vaultGit } from './vault-git.js'
import { flog } from './flog.js'
import { connectionProbe } from './connection-probe.js'
import { engineHealthOf, markEngineOk, revalidateEngines } from './engine-health.js'

export interface VaultContext {
  paths: VaultPaths
  git: { autoCommit(message: string): Promise<string | null> } | null
  engines: Engine[]
  provider: BinaryProvider
  store: NoteStore
}

let context: VaultContext | null = null
const detectionRevision = new WeakMap<VaultContext, number>()

export function binaryProvider(): BundledBinaryProvider {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'bin')
    : join(app.getAppPath(), 'bundle')
  return new BundledBinaryProvider(dir)
}

export async function configuredVaultRoot(): Promise<string | null> {
  if (process.env['ENGRAM_VAULT']) return process.env['ENGRAM_VAULT']
  return currentWorkspaceRoot()
}

export async function saveVaultRoot(root: string): Promise<void> {
  await registerWorkspace({ name: 'Engram', root, kind: 'personal' })
}

const filing = (settings: Parameters<typeof aiSelection>[0]) => ({ ...aiSelection(settings, 'filing'), engine: 'claude' as const })

export async function resolveEngines(keep: Iterable<EngineId> = []): Promise<Engine[]> {
  const engineFlag = process.env['ENGRAM_ENGINE'] ?? 'auto'
  if (engineFlag === 'mock') {
    const dir = process.env['ENGRAM_MOCK_DIR']
    const hang = !app.isPackaged && process.env['ENGRAM_TEST_HANG_CHAT'] === '1' ? { hangTimes: Number.MAX_SAFE_INTEGER } : {}
    const gapMs = app.isPackaged ? NaN : Number(process.env['ENGRAM_TEST_MOCK_GAP_MS'])
    return [dir ? await MockEngine.fromDir(dir, Number.isFinite(gapMs) ? { gapMs } : {}) : new MockEngine({}, hang)]
  }
  if (engineFlag === 'none') return []
  const selection = filing(await loadSettings())
  const chosen = selection.engine
  const engine = Object.assign(withModel(createEngine(chosen), selection.model, selection.effort), { authConfirmed: false })
  const known = keepSet(keep).has(chosen)
  try {
    const detection = await engine.detect()
    engine.authConfirmed = detection.loggedIn && detection.conclusive !== false
    return keepsEngine(detection, known) ? [engine] : []
  } catch {
    return known ? [engine] : []
  }
}

function keepSet(keep: Iterable<EngineId>): Set<EngineId> {
  return keep instanceof Set ? keep : new Set(keep)
}

const freshProbes = new WeakMap<Engine, number>()
export async function engineStates(ids: readonly EngineId[] = ENGINE_ORDER): Promise<EngineStatusDto[]> {
  const engineFlag = process.env['ENGRAM_ENGINE'] ?? 'auto'
  if (engineFlag === 'mock') return [{ id: 'mock', installed: true, loggedIn: true }]
  if (engineFlag === 'none') return [{ id: 'claude', installed: false, loggedIn: false }]
  const fresh = ids.length === 0
  return Promise.all((fresh ? ENGINE_ORDER : ids).map(async (id) => {
    const engine = createEngine(id) as Engine & { forgetStatus?: () => void }
    const turn = (freshProbes.get(engine) ?? 0) + 1
    if (fresh) { freshProbes.set(engine, turn); engine.forgetStatus?.() }
    const detection = await connectionProbe(() => engine.detect())
    const latest = fresh && freshProbes.get(engine) === turn
    if (latest && detection.conclusive === false) engine.forgetStatus?.()
    if (latest && detection.installed && detection.loggedIn && detection.conclusive !== false && engineHealthOf(id)?.reason === 'auth') markEngineOk(id)
    const health = engineHealthOf(id)
    return { id, ...detection, ...(health ? { healthy: health.healthy, healthReason: health.reason } : {}) }
  }))
}

export async function synchronizeFilingProbe(ctx: VaultContext, states: EngineStatusDto[]): Promise<void> {
  const selection = filing(await loadSettings())
  const status = states.find(state => state.id === selection.engine)
  const current = ctx.engines.find(engine => engine.id === selection.engine) as (Engine & { authConfirmed?: boolean }) | undefined
  if (status && status.conclusive !== false && (status.loggedIn && status.installed) !== (current?.authConfirmed === true)) await revalidateEngines(ctx, false, false)
}

export async function refreshEngines(ctx: VaultContext, selectionOnly = false): Promise<Engine[]> {
  const revision = (detectionRevision.get(ctx) ?? 0) + 1
  detectionRevision.set(ctx, revision)
  if (selectionOnly && (process.env['ENGRAM_ENGINE'] ?? 'auto') === 'auto') {
    const selection = filing(await loadSettings())
    const next = withModel(createEngine(selection.engine), selection.model, selection.effort) as Engine & { authConfirmed?: boolean; accountProfile?: string }
    const previous = ctx.engines.find(engine => engine.id === selection.engine) as typeof next | undefined
    if (previous && previous.accountProfile === next.accountProfile) {
      next.authConfirmed = previous.authConfirmed
      if (detectionRevision.get(ctx) === revision) ctx.engines = [next]
      return ctx.engines
    }
  }
  const engines = await resolveEngines(ctx.engines.map((e) => e.id))
  if (detectionRevision.get(ctx) === revision) ctx.engines = engines
  return ctx.engines
}

async function mergeOtherWorkspaces(paths: VaultPaths): Promise<void> {
  const { sources, shared } = await workspacesToMerge().catch(() => ({ sources: [], shared: false }))
  for (const source of sources) {
    try {
      const report = await mergeWorkspace(paths, source, { tracked: !shared })
      if (report) flog('workspace-merge', JSON.stringify(report))
    } catch (error) {
      flog('workspace-merge', `${source.root}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export async function openVaultContext(root: string): Promise<VaultContext> {
  if (context) return context
  const provider = binaryProvider()
  const useGit = process.env['ENGRAM_NO_GIT'] !== '1'
  const paths = useGit ? await vaultGit('init', root) : await initVault(root, { git: false, provider })
  const git = useGit ? { autoCommit: (message: string) => vaultGit('commit', root, message) } : null
  let botsReady = true
  try {
    await resetBotsToV2(paths)
  } catch (error) {
    botsReady = false
    console.error(`[vault] bot list reset failed, retrying on next open: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (botsReady && !process.env['ENGRAM_VAULT']) await mergeOtherWorkspaces(paths)
  const store = await NoteStore.open(paths)
  context = { paths, git, engines: [], provider, store }
  return context
}
