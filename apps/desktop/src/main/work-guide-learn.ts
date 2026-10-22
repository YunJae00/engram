import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  collectResult,
  engineCwd,
  GUIDE_SCHEMA,
  guideBody,
  guideForPrompt,
  guideNote,
  guidePrompt,
  readNote,
  WORK_GUIDE_NOTE_ID,
  writeNote,
  type GuideAnswer,
  type Note,
  type VaultPaths,
} from 'core'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'
import type { VaultContext } from './vault.js'

// How the person works, learned from what they answer while comets work
// rather than asked up front: a note they can edit or retire, read by every turn.
const GUIDE_TIMEOUT_MS = 180_000
const saves = new WeakMap<VaultContext, Promise<boolean>>()

async function readGuide(paths: VaultPaths): Promise<Note | null> {
  try {
    const info = await lstat(join(paths.notes, `${WORK_GUIDE_NOTE_ID}.md`))
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64000) throw new Error('The work guide must be a small local note.')
    return await readNote(paths, WORK_GUIDE_NOTE_ID)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// What every comet turn carries of the guide, or nothing.
export async function workGuide(paths: VaultPaths): Promise<string> {
  return guideForPrompt(await readGuide(paths).catch(() => null))
}

// One retry when the reply cannot be used: a model sometimes answers in prose.
async function ask<T>(ctx: VaultContext, prompt: string, signal: AbortSignal, read: (raw: string) => T): Promise<T> {
  signal.throwIfAborted()
  const engine = ctx.engines[0]
  if (!engine) throw new Error('Connect an AI first.')
  const run = (text: string) => collectResult(engine, { prompt: text, jsonSchema: GUIDE_SCHEMA, workdir: engineCwd(ctx.paths), disallowTools: true, timeoutMs: GUIDE_TIMEOUT_MS, signal })
  const raw = await run(prompt)
  signal.throwIfAborted()
  try { return read(raw) } catch {
    const again = await run(`${prompt}\n\nYour previous reply could not be used. Reply in exactly the requested format and nothing else.`)
    signal.throwIfAborted()
    return read(again)
  }
}

function saveGuide(ctx: VaultContext, given: GuideAnswer[], signal: AbortSignal): Promise<boolean> {
  const saving = (saves.get(ctx) ?? Promise.resolve(false)).catch(() => false).then(async () => {
    signal.throwIfAborted()
    const existing = await readGuide(ctx.paths)
    // A guide the person retired stays retired.
    if (existing && existing.front.status !== 'current') return false
    const sections = await ask(ctx, guidePrompt(given, existing?.body ?? ''), signal, guideBody)
    signal.throwIfAborted()
    const latest = await readGuide(ctx.paths)
    if (JSON.stringify(latest) !== JSON.stringify(existing)) throw new Error('Your work guide changed while it was being updated; the edit was kept.')
    await writeNote(ctx.paths, guideNote(sections, new Date(), existing, true))
    await ctx.store.applyFile('add', join(ctx.paths.notes, `${WORK_GUIDE_NOTE_ID}.md`))
    broadcast({ type: 'vault:changed' })
    return true
  })
  saves.set(ctx, saving)
  void saving.finally(() => { if (saves.get(ctx) === saving) saves.delete(ctx) }).catch(() => undefined)
  return saving
}

// An answer the person gave a comet's question, folded into their guide.
export function learnFromAnswer(ctx: VaultContext, question: string, answer: string): void {
  if (!question.trim() || !answer.trim() || question.length > 300 || answer.length > 1200) return
  void saveGuide(ctx, [{ question, answer }], AbortSignal.timeout(GUIDE_TIMEOUT_MS * 2))
    .catch(() => flog('work-guide', 'The work guide could not be updated. Existing guidance was kept.'))
}

// The guide's pending updates, settled.
export async function guideSettled(ctx: VaultContext): Promise<void> {
  await (saves.get(ctx) ?? Promise.resolve(false)).catch(() => false)
}
