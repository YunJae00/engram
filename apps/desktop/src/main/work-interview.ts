import { ipcMain } from 'electron'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  collectResult,
  engineCwd,
  GUIDE_SCHEMA,
  guideBody,
  guideForPrompt,
  guideNote,
  guidePrompt,
  INTERVIEW_SCHEMA,
  INTERVIEW_SOURCE_ID,
  interviewPrompt,
  parseInterviewQuestions,
  readNote,
  readPlaybooks,
  readWorkMap,
  renameWithRetry,
  selectInterviewEvidence,
  WORK_GUIDE_NOTE_ID,
  writeNote,
  type InterviewAnswer,
  type InterviewQuestion,
  type Note,
  type VaultPaths,
} from 'core'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'
import { loadSettings } from './settings.js'
import { primeWorkMap } from './work-map-job.js'
import type { VaultContext } from './vault.js'

const INTERVIEW_TIMEOUT_MS = 180_000
const saves = new WeakMap<VaultContext, Promise<boolean>>()
const exclusionsPath = (paths: VaultPaths) => join(paths.cache, 'interview-exclusions.json')

async function readExclusions(paths: VaultPaths): Promise<string[]> {
  try {
    const file = exclusionsPath(paths)
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32000) throw new Error('Interview preferences must be a small local file.')
    const value: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(value) || value.length > 500 || value.some(id => typeof id !== 'string' || !INTERVIEW_SOURCE_ID.test(id))) throw new Error('Interview preferences are invalid; the file was kept.')
    return value as string[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function saveExclusions(paths: VaultPaths, ids: string[], signal: AbortSignal): Promise<void> {
  const kept = [...new Set([...await readExclusions(paths), ...ids])]
  if (kept.length > 500) throw new Error('Too many interview preferences. Existing preferences were kept.')
  signal.throwIfAborted()
  await mkdir(paths.cache, { recursive: true })
  const scratch = `${exclusionsPath(paths)}.${process.pid}.tmp`
  try {
    await writeFile(scratch, JSON.stringify(kept))
    signal.throwIfAborted()
    await renameWithRetry(scratch, exclusionsPath(paths))
  } finally { await rm(scratch, { force: true }) }
}

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
  const settings = await loadSettings()
  if (settings.workMap) await primeWorkMap(ctx).catch(() => undefined)
  signal.throwIfAborted()
  const [map, playbooks, excludedIds] = await Promise.all([
    settings.workMap ? readWorkMap(ctx.paths).catch(() => null) : null,
    readPlaybooks(ctx.paths).catch(() => []),
    readExclusions(ctx.paths),
  ])
  const existing = await readGuide(ctx.paths)
  const guide = existing?.front.status === 'current' ? existing.body : ''
  signal.throwIfAborted()
  return selectInterviewEvidence({ map, playbooks, guide, excludedIds })
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
  let issued: InterviewQuestion[] = []
  const request = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    current?.abort()
    const controller = new AbortController()
    current = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(INTERVIEW_TIMEOUT_MS * 2)])
    try { return await run(signal) } finally { if (current === controller) current = undefined }
  }
  ipcMain.handle('interview:questions', async (): Promise<InterviewQuestion[]> => {
    return request(async signal => {
      issued = []
      const known = await evidence(ctx, signal)
      if (!known.sources.length) return []
      const questions = await ask(ctx, interviewPrompt(known), INTERVIEW_SCHEMA, signal, raw => parseInterviewQuestions(raw, known))
      signal.throwIfAborted()
      issued = questions
      return questions
    })
  })
  ipcMain.handle('interview:save', async (_e, answers: unknown): Promise<{ saved: boolean }> => {
    const given = checkedAnswers(answers)
    const rejected = given.filter(one => one.rejected)
    if (rejected.some(one => !issued.some(question => question.source === one.source && question.question === one.question))) throw new Error('Only a question from this interview can be dismissed.')
    return request(async signal => {
      const saved = await saveGuide(ctx, given.filter(one => !one.rejected), signal, false, rejected.map(one => one.source!))
      if (saved && given.some(one => !one.rejected)) onSaved?.()
      return { saved }
    })
  })
  ipcMain.handle('interview:cancel', () => { current?.abort(); current = undefined })
}

function checkedAnswers(value: unknown): InterviewAnswer[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error('Supply up to 10 interview answers.')
  return value.map(one => {
    if (typeof one?.question !== 'string' || typeof one?.answer !== 'string' || one.question.length > 300 || one.answer.length > 1200 || /\0/.test(one.question + one.answer)) throw new Error('An interview answer is invalid or too long.')
    if ((one.rejected !== undefined && typeof one.rejected !== 'boolean') || (one.source !== undefined && (typeof one.source !== 'string' || !INTERVIEW_SOURCE_ID.test(one.source))) || (one.rejected && (!one.source || one.answer.trim()))) throw new Error('An interview preference is invalid.')
    return { question: one.question.trim(), answer: one.answer.trim(), ...(one.source ? { source: one.source as string } : {}), ...(one.rejected ? { rejected: true } : {}) }
  }).filter(one => one.question && (one.answer || one.rejected))
}

function saveGuide(ctx: VaultContext, given: InterviewAnswer[], signal: AbortSignal, automatic = false, rejected: string[] = []): Promise<boolean> {
  const saving = (saves.get(ctx) ?? Promise.resolve(false)).catch(() => false).then(async () => {
    signal.throwIfAborted()
    if (!given.length) {
      if (rejected.length) await saveExclusions(ctx.paths, rejected, signal)
      return rejected.length > 0
    }
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
    if (rejected.length) await saveExclusions(ctx.paths, rejected, signal)
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
