import { contentDelta, extractDocumentText, extractableKind, isTransientArtifact, writeCapture } from 'core'
import chokidar, { type FSWatcher } from 'chokidar'
import { app, dialog, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { flog } from './flog.js'
import type { VaultContext } from './vault.js'

// Content capture — the product's heart: documents
// the user works on become memories WITHOUT anyone writing a note. Watch the
// folders the user consented to; on save, extract the text locally, keep only
// what changed since the last save, and drop it into the librarian's inbox
// with honest provenance. Local files, local parsing, local model — nothing
// leaves the machine, which is the entire reason reading content is
// defensible on a corporate laptop.

interface ContentState {
  // Consent gate: empty = feature off. The user picked these.
  folders: string[]
}

let ctx: VaultContext | null = null
let watcher: FSWatcher | null = null
// path → debounce timer; Office fires several events per save.
const pending = new Map<string, NodeJS.Timeout>()
const DEBOUNCE_MS = 4_000
// Last extracted text per document, so a save captures its DELTA. Kept under
// .engram (derived data, never synced).
function snapDir(vault: VaultContext): string {
  return join(vault.paths.workspace, '.engram', 'content-snap')
}

function stateFile(): string {
  return join(app.getPath('userData'), 'content-capture.json')
}

// The folders the person allowed, for anything that must stay inside them.
export async function consentedFolders(): Promise<string[]> {
  return readState().then((state) => state.folders)
}

async function readState(): Promise<ContentState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile(), 'utf8')) as ContentState
    return { folders: Array.isArray(parsed.folders) ? parsed.folders.filter((f) => typeof f === 'string') : [] }
  } catch {
    return { folders: [] }
  }
}

async function saveState(state: ContentState): Promise<void> {
  await writeFile(stateFile(), JSON.stringify(state)).catch(() => undefined)
}

function snapPath(vault: VaultContext, docPath: string): string {
  return join(snapDir(vault), `${createHash('sha1').update(docPath.toLowerCase()).digest('hex')}.txt`)
}

async function handleSave(path: string): Promise<void> {
  const vault = ctx
  if (!vault) return
  if (!extractableKind(path) || isTransientArtifact(path)) return
  const text = await extractDocumentText(path)
  if (!text) return // unreadable/locked/scan — the desk journal still has the skeleton
  const snap = snapPath(vault, path)
  const previous = await readFile(snap, 'utf8').catch(() => null)
  const delta = await contentDelta(previous, text)
  const name = basename(path)
  if (delta.trim().length >= 40) {
    // Capture BEFORE snapshot: once the snapshot holds the new text, a
    // failed capture's delta can never be re-derived. In this order a failed
    // capture leaves the old snapshot and the next save re-captures the
    // accumulated delta.
    const capture = `[document] ${name}\n${delta}`
    await writeCapture(vault.paths.inbox, capture, 'session', `file:${name}`)
    flog('content-capture', `${name}: +${delta.length} chars`)
  }
  await mkdir(snapDir(vault), { recursive: true }).catch(() => undefined)
  await writeFile(snap, text).catch(() => undefined)
}

function schedule(path: string): void {
  const key = path.toLowerCase()
  clearTimeout(pending.get(key))
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      void handleSave(path).catch((err) => flog('content-capture-failed', err))
    }, DEBOUNCE_MS),
  )
}

async function startWatcher(): Promise<void> {
  const state = await readState()
  await stopContentCapture()
  if (state.folders.length === 0 || !ctx) return
  watcher = chokidar.watch(state.folders, {
    ignoreInitial: true, // change-driven by design: only files the user actually saves are read (OneDrive placeholders stay cold)
    depth: 6,
    usePolling: false,
    awaitWriteFinish: { stabilityThreshold: 1_500, pollInterval: 400 },
    ignored: (p) => /node_modules|\.git|\.engram/.test(p),
  })
  watcher.on('add', schedule)
  watcher.on('change', schedule)
  watcher.on('error', (err: unknown) => flog('content-capture-watch-error', err))
  flog('content-capture', `watching ${state.folders.length} folder(s)`)
}

export function startContentCapture(vault: VaultContext): void {
  ctx = vault
  void startWatcher()
}

export async function stopContentCapture(): Promise<void> {
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
  await watcher?.close().catch(() => undefined)
  watcher = null
}

export function registerContentCaptureIpc(): void {
  ipcMain.handle('content:folders', () => consentedFolders())
  ipcMain.handle('content:addFolder', async () => {
    const result = await dialog.showOpenDialog({ title: 'Watch a folder', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return readState().then((s) => s.folders)
    const state = await readState()
    if (!state.folders.includes(result.filePaths[0])) state.folders.push(result.filePaths[0])
    await saveState(state)
    await startWatcher()
    return state.folders
  })
  ipcMain.handle('content:removeFolder', async (_e, folder: string) => {
    const state = await readState()
    state.folders = state.folders.filter((f) => f !== folder)
    await saveState(state)
    await startWatcher()
    return state.folders
  })
}
