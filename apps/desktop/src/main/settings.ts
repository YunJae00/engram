import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { renameWithRetry } from 'core'
import { join } from 'node:path'

export interface AppSettings {
  accessibilityTrustedVersion?: string
  aiSelections: Record<string, { engine: 'claude' | 'codex'; model: string; effort?: import('core').ReasoningEffort; permission?: import('core').PermissionMode }>
  claudeEffort?: import('core').ReasoningEffort
  codexEffort?: import('core').ReasoningEffort
  theme: 'system' | 'light' | 'dark'
  uiLanguage: 'system' | 'ko' | 'en'
  defaultEngine: 'claude' | 'codex'
  autoStart: boolean
  teamSync: 'auto' | 'manual'
  searchTemplate: string
  agentBrowser: string
  claudeModel: string
  codexModel: string
  computerUse: boolean
  workMap: boolean
  workFiles: boolean
  workApps: boolean
  nativeTools: boolean
  appsOff: { app: string; label: string }[]
}

const DEFAULT_SETTINGS: AppSettings = {
  aiSelections: {},
  theme: 'system',
  uiLanguage: 'system',
  defaultEngine: 'claude',
  autoStart: true,
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
    merged.defaultEngine = 'claude'
    merged.computerUse = true
    merged.workMap = merged.workMap === true
    merged.workFiles = merged.workFiles === true
    merged.workApps = merged.workApps === true
    merged.nativeTools = merged.nativeTools !== false
    merged.appsOff = appsOffOf(merged.appsOff)
    merged.aiSelections = Object.fromEntries(Object.entries(merged.aiSelections ?? {}).filter(([scope, value]) =>
      /^(filing|cosmos|panel|bot-[a-zA-Z0-9_-]{1,100})$/.test(scope) && value && ['claude', 'codex'].includes(value.engine) && typeof value.model === 'string' && value.model.length <= 200))
    if (!['system', 'light', 'dark'].includes(merged.theme)) merged.theme = 'system'
    if (!['system', 'ko', 'en'].includes(merged.uiLanguage)) merged.uiLanguage = 'system'
    for (const selection of Object.values(merged.aiSelections)) { selection.engine = 'claude'; delete selection.effort }
    delete merged.claudeEffort
    delete merged.codexEffort
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
    settings.computerUse = true
    await saveSettings(settings)
    return settings
  })
  changes = next.then(() => undefined, () => undefined)
  return next
}
