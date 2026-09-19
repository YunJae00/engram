import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { renameWithRetry, REASONING_EFFORTS } from 'core'
import { join } from 'node:path'

interface AppSettings {
  aiSelections: Record<string, { engine: 'claude' | 'codex'; model: string; effort?: import('core').ReasoningEffort }>
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
  // Foreground input is opt-in and remains separate from browser access.
  computerUse: boolean
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
  computerUse: false,
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

async function readSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<AppSettings>
    const merged = { ...DEFAULT_SETTINGS, ...raw }
    // An old file may name a brain this build does not carry; the one on
    // this disk is the safe reading.
    if (!['claude', 'codex'].includes(merged.defaultEngine as string)) merged.defaultEngine = 'claude'
    merged.computerUse = merged.computerUse === true
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

async function saveSettings(settings: AppSettings): Promise<void> {
  const target = settingsPath()
  await writeFile(`${target}.tmp`, JSON.stringify(settings, null, 2))
  await renameWithRetry(`${target}.tmp`, target)
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
