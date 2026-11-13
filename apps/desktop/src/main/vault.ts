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
  type VaultPaths, ENGINE_ORDER, keepsEngine, resetBotsToV2 } from 'core'
import { loadSettings } from './settings.js'
import { aiSelection, withModel } from './ai-selection.js'
import { app } from 'electron'
import { join } from 'node:path'
import { currentWorkspaceRoot, registerWorkspace } from './workspaces.js'
import { vaultGit } from './vault-git.js'
import { connectionProbe } from './connection-probe.js'
import { engineHealthOf, markEngineOk, revalidateEngines } from './engine-health.js'

// Vault + engine context for the main process. Env knobs used by dev/e2e:
//   ENGRAM_VAULT     vault root (skips onboarding)
//   ENGRAM_USERDATA  userData override (e2e isolation)
//   ENGRAM_NO_GIT=1  skip the hidden git layer (fast e2e on slow fs)
//   ENGRAM_ENGINE    mock | none | auto (default auto)
//   ENGRAM_MOCK_DIR  canned responses for the mock engine
export interface VaultContext {
  paths: VaultPaths
  git: { autoCommit(message: string): Promise<string | null> } | null
  engines: Engine[]
  provider: BinaryProvider
  // In-memory, watcher-driven view over notes/. The markdown files remain the
  // source of truth; this store is a derived cache kept in sync by the notes
  // watcher (see main/index.ts) and rebuildable from disk at any time.
  store: NoteStore
}

let context: VaultContext | null = null
const detectionRevision = new WeakMap<VaultContext, number>()

// Bundled binaries live under resources/bin in packaged builds and under
// apps/desktop/bundle in dev (after `pnpm bundle:binaries`).
export function binaryProvider(): BundledBinaryProvider {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'bin')
    : join(app.getAppPath(), 'bundle')
  return new BundledBinaryProvider(dir)
}

// Where is the vault? env → active workspace in the registry → null (null = run
// onboarding). The registry handles legacy vault.json migration internally.
export async function configuredVaultRoot(): Promise<string | null> {
  if (process.env['ENGRAM_VAULT']) return process.env['ENGRAM_VAULT']
  return currentWorkspaceRoot()
}

// Onboarding persists the first vault by registering it as the Engram
// workspace (which also sets it current).
export async function saveVaultRoot(root: string): Promise<void> {
  await registerWorkspace({ name: 'Engram', root, kind: 'personal' })
}

// Background work uses only the filing selection. Conversations resolve
// their own selection separately; an unavailable provider never falls back.
export async function resolveEngines(keep: Iterable<EngineId> = []): Promise<Engine[]> {
  const engineFlag = process.env['ENGRAM_ENGINE'] ?? 'auto'
  if (engineFlag === 'mock') {
    const dir = process.env['ENGRAM_MOCK_DIR']
    const hang = !app.isPackaged && process.env['ENGRAM_TEST_HANG_CHAT'] === '1' ? { hangTimes: Number.MAX_SAFE_INTEGER } : {}
    const gapMs = app.isPackaged ? NaN : Number(process.env['ENGRAM_TEST_MOCK_GAP_MS'])
    return [dir ? await MockEngine.fromDir(dir, Number.isFinite(gapMs) ? { gapMs } : {}) : new MockEngine({}, hang)]
  }
  if (engineFlag === 'none') return []
  const selection = aiSelection(await loadSettings(), 'filing')
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

// The honest per-engine picture for setup UI: "installed but not logged in" is
// a state the user can ACT on, and resolveEngines collapses it into absence.
// Mock/none stay forced so e2e and --engine flags behave the same everywhere.
// An empty list asks for a fresh check of every provider (onboarding after an
// outside CLI login): cached and pending status probes are dropped first.
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
    // Only the newest fresh check may drop a hung probe; an older one would void the newer generation.
    if (latest && detection.conclusive === false) engine.forgetStatus?.()
    // A fresh signed-in status after an outside login replaces an earlier auth failure.
    if (latest && detection.installed && detection.loggedIn && detection.conclusive !== false && engineHealthOf(id)?.reason === 'auth') markEngineOk(id)
    const health = engineHealthOf(id)
    return { id, ...detection, ...(health ? { healthy: health.healthy, healthReason: health.reason } : {}) }
  }))
}

export async function synchronizeFilingProbe(ctx: VaultContext, states: EngineStatusDto[]): Promise<void> {
  const selection = aiSelection(await loadSettings(), 'filing')
  const status = states.find(state => state.id === selection.engine)
  const current = ctx.engines.find(engine => engine.id === selection.engine) as (Engine & { authConfirmed?: boolean }) | undefined
  if (status && status.conclusive !== false && (status.loggedIn && status.installed) !== (current?.authConfirmed === true)) await revalidateEngines(ctx, false, false)
}

// Re-detects engines in place (e.g. right after the user logs a CLI in via
// the embedded terminal) — the shared ctx reference updates for every IPC
// handler, so no restart is needed. Safe to call from anywhere at any rate:
// concurrent probes collapse inside the adapter (ClaudeAdapter.detect).
export async function refreshEngines(ctx: VaultContext, selectionOnly = false): Promise<Engine[]> {
  const revision = (detectionRevision.get(ctx) ?? 0) + 1
  detectionRevision.set(ctx, revision)
  if (selectionOnly && (process.env['ENGRAM_ENGINE'] ?? 'auto') === 'auto') {
    const selection = aiSelection(await loadSettings(), 'filing')
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

export async function openVaultContext(root: string): Promise<VaultContext> {
  if (context) return context
  const provider = binaryProvider()
  const useGit = process.env['ENGRAM_NO_GIT'] !== '1'
  const paths = useGit ? await vaultGit('init', root) : await initVault(root, { git: false, provider })
  const git = useGit ? { autoCommit: (message: string) => vaultGit('commit', root, message) } : null
  const store = await NoteStore.open(paths)
  try {
    await resetBotsToV2(paths)
  } catch (error) {
    console.error(`[vault] bot list reset failed, retrying on next open: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Engines start EMPTY and are detected in the background (bootVault kicks it
  // off). Detection spawns `claude --version` and `claude auth status` — two
  // subprocesses measured at 3.6s together on an idle machine, against 88ms for
  // reading and indexing a 135-note vault. Awaiting it here put those seconds
  // in front of the first paint on every single launch, which is most of what
  // "the app is slow" was. Nothing in the opening path needs an engine: the
  // sweep, chat and pipeline all already check for one and wait.
  context = { paths, git, engines: [], provider, store }
  return context
}
