import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface AppSettings {
  // Which brain answers: the one on this disk, or one of the two the person
  // signed in to. Chosen once, never switched behind their back.
  defaultEngine: 'local' | 'claude' | 'codex'
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
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultEngine: 'local',
  autoStart: false,
  teamSync: 'auto',
  searchTemplate: '',
  agentBrowser: '',
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<AppSettings>
    const merged = { ...DEFAULT_SETTINGS, ...raw }
    // An old file may name a brain this build does not carry; the one on
    // this disk is the safe reading.
    if (!['local', 'claude', 'codex'].includes(merged.defaultEngine as string)) merged.defaultEngine = 'local'
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2))
}
