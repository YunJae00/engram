import { app, ipcMain } from 'electron'
import { lstat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import {
  collectResult,
  engineCwd,
  findLocalFiles,
  GUIDE_SCHEMA,
  guideBody,
  guideForPrompt,
  guideNote,
  guidePrompt,
  INTERVIEW_SCHEMA,
  interviewPrompt,
  parseInterviewQuestions,
  readNote,
  readWorkMap,
  WORK_GUIDE_NOTE_ID,
  writeNote,
  type InterviewAnswer,
  type InterviewQuestion,
  type Note,
  type VaultPaths,
} from 'core'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'
import type { VaultContext } from './vault.js'

const INTERVIEW_TIMEOUT_MS = 180_000
const FOLDERS = ['documents', 'desktop', 'downloads'] as const
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

async function evidence(ctx: VaultContext, signal: AbortSignal) {
  // Isolated app profiles must never inspect the person's real folders.
  const roots = process.env['ENGRAM_USERDATA'] ? [] : FOLDERS.map((name) => app.getPath(name))
  const found = await findLocalFiles(roots, ctx.paths.privateDir, '.', signal).catch(() => ({ matches: [] }))
  signal.throwIfAborted()
  const files = found.matches
    .sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''))
    .map((file) => {
      const root = roots.find((one) => { const part = relative(one, file.path); return !part.startsWith('..') && !isAbsolute(part) })
      return root ? `${basename(root)}/${relative(root, file.path).replace(/\\/g, '/')}` : file.name
    })
  const map = await readWorkMap(ctx.paths).catch(() => null)
  const places = (map?.places ?? []).filter((place) => place.work !== false).flatMap((place) => {
    try { return [new URL(`https://${place.host}`).hostname] } catch { return [] }
  })
  const existing = await readGuide(ctx.paths)
  const guide = existing?.front.status === 'current' ? existing.body : ''
  return { files, places, facts: [], ...(guide ? { guide } : {}) }
}

// One retry when the reply cannot be used: a model sometimes answers in prose.
async function ask<T>(ctx: VaultContext, prompt: string, schema: object, signal: AbortSignal, read: (raw: string) => T): Promise<T> {
  signal.throwIfAborted()
  const engine = ctx.engines[0]
  if (!engine) throw new Error('Connect an AI first.')
  const run = (text: string) => collectResult(engine, { prompt: text, jsonSchema: schema, workdir: engineCwd(ctx.paths), disallowTools: true, timeoutMs: INTERVIEW_TIMEOUT_MS, signal })
  const raw = await run(prompt)
  signal.throwIfAborted()
  try { return read(raw) } catch {
    const again = await run(`${prompt}\n\nYour previous reply could not be used. Reply in exactly the requested format and nothing else.`)
    signal.throwIfAborted()
    return read(again)
  }
}

export function registerWorkInterviewIpc(ctx: VaultContext, onSaved?: () => void): void {
  let current: AbortController | undefined
  const request = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    current?.abort()
    const controller = new AbortController()
    current = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(INTERVIEW_TIMEOUT_MS * 2)])
    try { return await run(signal) } finally { if (current === controller) current = undefined }
  }
  ipcMain.handle('interview:questions', async (): Promise<InterviewQuestion[]> => {
    return request(async signal => ask(ctx, interviewPrompt(await evidence(ctx, signal)), INTERVIEW_SCHEMA, signal, parseInterviewQuestions))
  })
  ipcMain.handle('interview:save', async (_e, answers: unknown): Promise<{ saved: boolean }> => {
    const given = checkedAnswers(answers)
    return request(async signal => {
      const saved = await saveGuide(ctx, given, signal)
      if (saved) onSaved?.()
      return { saved }
    })
  })
  ipcMain.handle('interview:cancel', () => { current?.abort(); current = undefined })
}

function checkedAnswers(value: unknown): InterviewAnswer[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error('Supply up to 10 interview answers.')
  return value.map(one => {
    if (typeof one?.question !== 'string' || typeof one?.answer !== 'string' || one.question.length > 300 || one.answer.length > 1200 || /\0/.test(one.question + one.answer)) throw new Error('An interview answer is invalid or too long.')
    return { question: one.question.trim(), answer: one.answer.trim() }
  }).filter(one => one.question && one.answer)
}

function saveGuide(ctx: VaultContext, given: InterviewAnswer[], signal: AbortSignal, automatic = false): Promise<boolean> {
  const saving = (saves.get(ctx) ?? Promise.resolve(false)).catch(() => false).then(async () => {
    signal.throwIfAborted()
    if (!given.length) return false
    const existing = await readGuide(ctx.paths)
    // A current guide records opt-in; declining or retiring it must not restart learning.
    if (automatic && existing?.front.status !== 'current') return false
    const sections = await ask(ctx, guidePrompt(given, existing?.body ?? ''), GUIDE_SCHEMA, signal, guideBody)
    signal.throwIfAborted()
    const latest = await readGuide(ctx.paths)
    if (JSON.stringify(latest) !== JSON.stringify(existing)) throw new Error('Your work guide changed. Try saving again to keep those edits.')
    signal.throwIfAborted()
    await writeNote(ctx.paths, guideNote(sections, new Date(), existing, automatic))
    await ctx.store.applyFile('add', join(ctx.paths.notes, `${WORK_GUIDE_NOTE_ID}.md`))
    broadcast({ type: 'vault:changed' })
    return true
  })
  saves.set(ctx, saving)
  void saving.finally(() => { if (saves.get(ctx) === saving) saves.delete(ctx) }).catch(() => undefined)
  return saving
}

export function learnFromAnswer(ctx: VaultContext, question: string, answer: string): void {
  if (!question.trim() || !answer.trim() || question.length > 300 || answer.length > 1200) return
  void saveGuide(ctx, [{ question, answer }], AbortSignal.timeout(INTERVIEW_TIMEOUT_MS * 2), true)
    .catch(() => flog('work-interview', 'The work guide could not be updated. Existing guidance was kept.'))
}
