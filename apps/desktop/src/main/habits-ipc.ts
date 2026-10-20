import { ipcMain } from 'electron'
import {
  addNotice,
  appendBotTurn,
  changeNotices,
  collectResult,
  createBot,
  engineBackoff,
  engineCwd,
  extractJson,
  habitCandidate,
  habitChains,
  habitPrompt,
  habitRevisePrompt,
  habitsToDraft,
  installSkill,
  loadBots,
  parseSkillDraft,
  readBotTranscript,
  readHabits,
  scriptLanguage,
  usedApps,
  writeHabits,
  type HabitEntry,
  type HabitLedger,
  type SkillDraft,
} from 'core'
import type { AppUseDto, HabitDraftDto } from '../shared/types.js'
import { readActivityRange, setActivityAppsOff } from './activity-watch.js'
import { setDesktopAppsOff } from './desktop-access.js'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'
import { loadSettings, onSettingsSaved, updateSettings, type AppSettings } from './settings.js'
import type { VaultContext } from './vault.js'

// The apps the person uses, which of them Engram may learn from and work in,
// and the runs of apps they keep going through for one job - drafted into a
// how-to by one model call, kept only when the person says it is right.

const WINDOW_MS = 30 * 86_400_000
const SCAN_EVERY_MS = 86_400_000
const DRAFTS_PER_SCAN = 2

function applyAppsOff(settings: AppSettings): void {
  setActivityAppsOff(settings.appsOff.map(one => one.app))
  setDesktopAppsOff(settings.appsOff.map(one => one.label))
}

// The language the person writes to Engram in; with no chat yet, the one
// their own window titles are in.
async function personLanguage(ctx: VaultContext, titles: string[]): Promise<string> {
  const said: string[] = []
  for (const bot of (await loadBots(ctx.paths).catch(() => [])).slice(-8)) {
    const turns = await readBotTranscript(ctx.paths, bot.id, 20).catch(() => [])
    said.push(...turns.filter(turn => turn.role === 'user').map(turn => turn.text))
  }
  const sample = said.slice(-12).join('\n') || titles.join('\n')
  const named = scriptLanguage(sample)
  if (named && named !== 'English') return named
  const line = said.at(-1)?.replace(/\s+/g, ' ').slice(0, 120)
  return line ? `the language of this line the person wrote: "${line}"` : named || 'English'
}

let scanning: Promise<number> | null = null
let lastScan = 0

export function scanHabits(ctx: VaultContext, force = false): Promise<number> {
  if (scanning) return scanning
  if (!force && Date.now() - lastScan < SCAN_EVERY_MS) return Promise.resolve(0)
  scanning = (async () => {
    lastScan = Date.now()
    const engine = ctx.engines[0]
    if (!engine || engineBackoff.blockedMs() > 0) return 0
    const settings = await loadSettings()
    const spans = await readActivityRange(ctx, Date.now() - WINDOW_MS, Date.now())
    const chains = habitChains(spans, new Set(settings.appsOff.map(one => one.app)))
    const ledger = await readHabits(ctx.paths)
    const language = await personLanguage(ctx, spans.slice(-40).map(span => span.title))
    let drafted = 0
    for (const chain of habitsToDraft(chains, ledger).slice(0, DRAFTS_PER_SCAN)) {
      const labels = chain.steps.map(step => step.label)
      // A brain that did not answer has not judged the run; it is asked again next time.
      const raw = await collectResult(engine, { prompt: habitPrompt(chain, language), workdir: engineCwd(ctx.paths), disallowTools: true, timeoutMs: 60_000, modelHint: 'fast', maxTokens: 1200 })
        .catch((error: unknown) => { flog('habits', `${labels.join(' > ')}: no answer - ${error instanceof Error ? error.message : String(error)}`); return null })
      if (raw === null) continue
      const draft = parseSkillDraft(raw)
      if (draft) await raise(ctx, chain.key, draft, raw)
      ledger[chain.key] = draft
        ? { state: 'draft', at: new Date().toISOString(), times: chain.times.length, labels, draft }
        : { state: 'declined', at: new Date().toISOString(), times: chain.times.length, labels }
      flog('habits', `${labels.join(' > ')}: ${draft ? 'drafted' : /"skip"\s*:\s*true/.test(raw) ? 'declined' : `unreadable answer, ${raw.length} chars`}`)
      if (draft) drafted++
    }
    await writeHabits(ctx.paths, ledger)
    if (drafted) { broadcast({ type: 'habits:changed' }); broadcast({ type: 'notices:changed' }) }
    return drafted
  })().finally(() => { scanning = null })
  return scanning
}

// A draft is raised in the inbox; its conversation is opened only when the
// person opens it there, so nothing waits in the list unasked.
async function raise(ctx: VaultContext, key: string, draft: SkillDraft, raw: string): Promise<void> {
  const said = (extractJson(raw) as { ask?: unknown } | null)?.ask
  const ask = typeof said === 'string' && said.trim() ? said.trim() : draft.description
  await addNotice(ctx.paths, { kind: 'habit', title: draft.title, text: ask, key }).catch(error => flog('habits', error))
}

// Opening a draft from the inbox: Engram says it first in a new conversation,
// where the person can answer its questions before keeping it.
export async function openHabit(ctx: VaultContext, key: string, ask: string): Promise<string> {
  const ledger = await readHabits(ctx.paths)
  const entry = ledger[key]
  if (entry?.botId && (await loadBots(ctx.paths)).some(bot => bot.id === entry.botId)) return entry.botId
  if (!entry?.draft) throw new Error('That draft is no longer waiting.')
  // What the person says here fills the how-to in; it is not a job to do now.
  const bot = await createBot(ctx.paths, { name: entry.draft.title.slice(0, 60), purpose: 'Talk with the person about the how-to in this conversation\'s first message. What they say here fills that how-to in - acknowledge it briefly as such - and is not a task to carry out now unless they plainly ask for it.' })
  await appendBotTurn(ctx.paths, bot.id, { role: 'assistant', text: `${ask}\n\n${entry.draft.body}`, at: new Date().toISOString() })
  await writeHabits(ctx.paths, { ...await readHabits(ctx.paths), [key]: { ...entry, botId: bot.id } })
  broadcast({ type: 'bots:changed' })
  return bot.id
}

// What the person said in the draft's conversation, folded into the how-to
// before it is kept; the draft as it was when nothing was said or the brain
// cannot be reached.
async function revised(ctx: VaultContext, entry: HabitEntry): Promise<SkillDraft> {
  const draft = entry.draft!
  const engine = ctx.engines[0]
  if (!entry.botId || !engine) return draft
  const answers = (await readBotTranscript(ctx.paths, entry.botId, 40).catch(() => [])).filter(turn => turn.role === 'user').map(turn => turn.text)
  if (!answers.length) return draft
  const raw = await collectResult(engine, { prompt: habitRevisePrompt(draft, answers), workdir: engineCwd(ctx.paths), disallowTools: true, timeoutMs: 60_000, modelHint: 'fast', maxTokens: 1500 }).catch(() => null)
  return parseSkillDraft(raw) ?? draft
}

const drafts = (ledger: HabitLedger): HabitDraftDto[] => Object.entries(ledger)
  .filter(([, entry]) => entry.state === 'draft' && entry.draft)
  .map(([key, entry]) => ({ key, labels: entry.labels, times: entry.times, title: entry.draft!.title, description: entry.draft!.description, body: entry.draft!.body, ...(entry.botId ? { botId: entry.botId } : {}) }))

export function registerHabitsIpc(ctx: VaultContext): void {
  void loadSettings().then(applyAppsOff).catch(() => undefined)
  onSettingsSaved(applyAppsOff)
  ipcMain.handle('apps:list', async (): Promise<AppUseDto[]> => {
    const off = (await loadSettings()).appsOff
    const used = usedApps(await readActivityRange(ctx, Date.now() - WINDOW_MS, Date.now()))
    const rows = used.map(one => ({ app: one.app, label: one.label, hours: Math.round(one.ms / 360_000) / 10, days: one.days, on: !off.some(kept => kept.app === one.app) }))
    return [...rows, ...off.filter(kept => !used.some(one => one.app === kept.app)).map(kept => ({ app: kept.app, label: kept.label, hours: 0, days: 0, on: false }))]
  })
  ipcMain.handle('apps:set', async (_event, app: unknown, label: unknown, on: unknown) => {
    if (typeof app !== 'string' || !app.trim() || app.length > 80 || typeof label !== 'string' || label.length > 80 || typeof on !== 'boolean') throw new Error('Invalid app')
    const key = app.trim().toLowerCase()
    const settings = await updateSettings(held => ({ ...held, appsOff: on ? held.appsOff.filter(one => one.app !== key) : [...held.appsOff.filter(one => one.app !== key), { app: key, label: label.trim() || key }] }))
    broadcast({ type: 'settings:changed', settings })
  })
  ipcMain.handle('habits:list', async () => drafts(await readHabits(ctx.paths)))
  ipcMain.handle('habits:scan', async () => { await scanHabits(ctx, true); return drafts(await readHabits(ctx.paths)) })
  ipcMain.handle('habits:answer', async (_event, key: unknown, keep: unknown) => {
    if (typeof key !== 'string' || typeof keep !== 'boolean') throw new Error('Invalid habit')
    const ledger = await readHabits(ctx.paths)
    const entry = ledger[key]
    if (entry?.state !== 'draft' || !entry.draft) throw new Error('That draft is no longer waiting.')
    if (keep) {
      const result = await installSkill(ctx.paths, habitCandidate(key), await revised(ctx, entry))
      if (!result.installed) throw new Error(result.reason === 'privacy' ? 'The draft holds an address or a key, so it was not kept.' : 'The how-to could not be kept.')
    }
    ledger[key] = { ...entry, state: keep ? 'kept' : 'dismissed', at: new Date().toISOString() }
    await writeHabits(ctx.paths, ledger)
    await changeNotices(ctx.paths, items => items.map(item => item.key === key ? { ...item, read: true } : item))
    broadcast({ type: 'habits:changed' })
    broadcast({ type: 'notices:changed' })
    return drafts(ledger)
  })
}
