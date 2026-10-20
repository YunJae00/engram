import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { renameWithRetry, REASONING_EFFORTS } from 'core'
import { join } from 'node:path'

export interface AppSettings {
  aiSelections: Record<string, { engine: 'claude' | 'codex'; model: string; effort?: import('core').ReasoningEffort; permission?: import('core').PermissionMode }>
  claudeEffort?: import('core').ReasoningEffort
  codexEffort?: import('core').ReasoningEffort
  theme: 'system' | 'light' | 'dark'
  // Which brain answers: the one on this disk, or one of the two the person
  // signed in to. Chosen once, never switched behind their back.
  defaultEngine: 'claude' | 'codex'
  autoStart: boolean // ⑦
  teamSync: 'auto' | 'manual' // ⑧ — surfaced in the GitHub backup dialog
  // The address the person searches with, with {q} where the words go. Empty
  // until they say: naming engines in code fixes the answer for everyone and
  // can never learn a company's own search.
  searchTemplate: string
  // Which installed browser the agent drives. Empty until the person says:
  // where several are installed, picking one for them is picking their
  // working day for them.
  agentBrowser: string
  // Which model each brain answers with, by the names the runtimes take -
  // an alias like "opus" for Claude, a model id for ChatGPT. Empty means
  // the runtime's own default, which follows the person's plan.
  claudeModel: string
  codexModel: string
  // Apps are always within reach: reading needs no permission, and anything
  // that cannot be taken back is asked about where it happens.
  computerUse: boolean
  // Learn where the person works from their browser history and bookmarks,
  // once a day. Opt-in: offered at onboarding and in Settings.
  workMap: boolean
  // The files opened and apps used on this computer, by name. Each opt-in.
  workFiles: boolean
  workApps: boolean
  // The runtime's own file, search and shell tools for comets, governed by Engram.
  nativeTools: boolean
  // Apps the person keeps out of Engram's reach: not recorded, not learned
  // from, not worked in. By process name, with the name the app shows.
  appsOff: { app: string; label: string }[]
}

const DEFAULT_SETTINGS: AppSettings = {
  aiSelections: {},
  theme: 'system',
  defaultEngine: 'claude',
  autoStart: false,
  teamSync: 'auto',
  searchTemplate: '',
  agentBrowser: '',
  claudeModel: '',
  codexModel: '',
  computerUse: true,
  workMap: false,
  workFiles: false,
  workApps: false,
  nativeTools: true,
  appsOff: [],
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

async function readSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<AppSettings> & { recordTasks?: unknown }
    delete raw.recordTasks
    const merged = { ...DEFAULT_SETTINGS, ...raw }
    // An old file may name a brain this build does not carry; the one on
    // this disk is the safe reading.
    if (!['claude', 'codex'].includes(merged.defaultEngine as string)) merged.defaultEngine = 'claude'
    merged.computerUse = true
    merged.workMap = merged.workMap === true
    merged.workFiles = merged.workFiles === true
    merged.workApps = merged.workApps === true
    merged.nativeTools = merged.nativeTools !== false
    merged.appsOff = appsOffOf(merged.appsOff)
    merged.aiSelections = Object.fromEntries(Object.entries(merged.aiSelections ?? {}).filter(([scope, value]) =>
      /^(filing|cosmos|panel|bot-[a-zA-Z0-9_-]{1,100})$/.test(scope) && value && ['claude', 'codex'].includes(value.engine) && typeof value.model === 'string' && value.model.length <= 200))
    if (!['system', 'light', 'dark'].includes(merged.theme)) merged.theme = 'system'
    for (const selection of Object.values(merged.aiSelections)) if (selection.effort && !REASONING_EFFORTS.includes(selection.effort)) delete selection.effort
    for (const key of ['claudeEffort', 'codexEffort'] as const) if (merged[key] && !REASONING_EFFORTS.includes(merged[key])) delete merged[key]
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function appsOffOf(value: unknown): AppSettings['appsOff'] {
  if (!Array.isArray(value)) return []
  return value.filter((one): one is { app: string; label: string } => typeof one?.app === 'string' && typeof one?.label === 'string' && one.app.trim().length > 0 && one.app.length <= 80 && one.label.length <= 80)
    .map(one => ({ app: one.app.trim().toLowerCase(), label: one.label.trim() || one.app.trim() })).slice(0, 200)
}

const saved = new Set<(settings: AppSettings) => void>()
export function onSettingsSaved(listener: (settings: AppSettings) => void): void { saved.add(listener) }

async function saveSettings(settings: AppSettings): Promise<void> {
  const target = settingsPath()
  await writeFile(`${target}.tmp`, JSON.stringify(settings, null, 2))
  await renameWithRetry(`${target}.tmp`, target)
  for (const listener of saved) listener(settings)
}

let changes = Promise.resolve()
export async function loadSettings(): Promise<AppSettings> {
  await changes
  return readSettings()
}

export function updateSettings(change: (settings: AppSettings) => AppSettings): Promise<AppSettings> {
  const next = changes.then(async () => {
    const settings = change(await readSettings())
    await saveSettings(settings)
    return settings
  })
  changes = next.then(() => undefined, () => undefined)
  return next
}
