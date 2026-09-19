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
  type VaultPaths, ENGINE_ORDER, keepsEngine } from 'core'
import { loadSettings } from './settings.js'
import { aiSelection, withModel } from './ai-selection.js'
import { app } from 'electron'
import { join } from 'node:path'
import { currentWorkspaceRoot, registerWorkspace } from './workspaces.js'
import { vaultGit } from './vault-git.js'

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
async function resolveEngines(keep: Iterable<EngineId> = []): Promise<Engine[]> {
  const engineFlag = process.env['ENGRAM_ENGINE'] ?? 'auto'
  if (engineFlag === 'mock') {
    const dir = process.env['ENGRAM_MOCK_DIR']
    return [dir ? await MockEngine.fromDir(dir) : new MockEngine()]
  }
  if (engineFlag === 'none') return []
  const selection = aiSelection(await loadSettings(), 'filing')
  const chosen = selection.engine
  const engine = withModel(createEngine(chosen), selection.model, selection.effort)
  const known = keepSet(keep).has(chosen)
  try {
    return keepsEngine(await engine.detect(), known) ? [engine] : []
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
export async function engineStates(ids: readonly EngineId[] = ENGINE_ORDER): Promise<EngineStatusDto[]> {
  const engineFlag = process.env['ENGRAM_ENGINE'] ?? 'auto'
  if (engineFlag === 'mock') return [{ id: 'mock', installed: true, loggedIn: true }]
  if (engineFlag === 'none') return [{ id: 'claude', installed: false, loggedIn: false }]
  return Promise.all(ids.map(async (id) => {
    const detection = await createEngine(id)
      .detect()
      .catch(() => ({ installed: false, loggedIn: false }))
    return { id, installed: detection.installed, loggedIn: detection.loggedIn }
  }))
}

// Re-detects engines in place (e.g. right after the user logs a CLI in via
// the embedded terminal) — the shared ctx reference updates for every IPC
// handler, so no restart is needed. Safe to call from anywhere at any rate:
// concurrent probes collapse inside the adapter (ClaudeAdapter.detect).
export async function refreshEngines(ctx: VaultContext, selectionOnly = false): Promise<Engine[]> {
  if (selectionOnly && (process.env['ENGRAM_ENGINE'] ?? 'auto') === 'auto') {
    const selection = aiSelection(await loadSettings(), 'filing')
    if (ctx.engines.some(engine => engine.id === selection.engine)) {
      ctx.engines = [withModel(createEngine(selection.engine), selection.model, selection.effort)]
      return ctx.engines
    }
  }
  ctx.engines = await resolveEngines(ctx.engines.map((e) => e.id))
  return ctx.engines
}

export async function openVaultContext(root: string): Promise<VaultContext> {
  if (context) return context
  const provider = binaryProvider()
  const useGit = process.env['ENGRAM_NO_GIT'] !== '1'
  const paths = useGit ? await vaultGit('init', root) : await initVault(root, { git: false, provider })
  const git = useGit ? { autoCommit: (message: string) => vaultGit('commit', root, message) } : null
  const store = await NoteStore.open(paths)
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
