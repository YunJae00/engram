import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface AppSettings {
  defaultEngine: 'claude' | 'local'
  autoStart: boolean // ⑦
  teamSync: 'auto' | 'manual' // ⑧ — surfaced in the GitHub backup dialog
  // The address the person searches with, with {q} where the words go. Empty
  // until they say: naming engines in code fixes the answer for everyone and
  // can never learn a company's own search.
  searchTemplate: string
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultEngine: 'local',
  autoStart: false,
  teamSync: 'auto',
  searchTemplate: '',
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<AppSettings>
    const merged = { ...DEFAULT_SETTINGS, ...raw }
    // Old files may carry engines that no longer exist (codex/antigravity) —
    // coerce the unknown to the on-device default instead of breaking detection.
    if ((merged.defaultEngine as string) !== 'claude' && (merged.defaultEngine as string) !== 'local')
      merged.defaultEngine = 'local'
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2))
}
