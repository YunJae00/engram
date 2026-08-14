import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface AppSettings {
  defaultEngine: 'claude'
  autoStart: boolean // ⑦
  teamSync: 'auto' | 'manual' // ⑧ — surfaced in the GitHub backup dialog
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultEngine: 'claude',
  autoStart: false,
  teamSync: 'auto',
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<AppSettings>
    const merged = { ...DEFAULT_SETTINGS, ...raw }
    // A settings.json written before the Claude-only decision may still say
    // codex/antigravity — coerce once instead of breaking detection.
    if ((merged.defaultEngine as string) !== 'claude') merged.defaultEngine = 'claude'
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2))
}
