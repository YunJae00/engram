import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { flog } from './flog.js'

const PROFILE_NAME = 'Engram'
const INK_ARGB = 0xff2b2b33 | 0
const THEME = { user_color: INK_ARGB, color_variant: 1, color_scheme: 2 }

type Prefs = Record<string, unknown>

function section(prefs: Prefs, key: string): Prefs {
  const held = prefs[key]
  if (held && typeof held === 'object' && !Array.isArray(held)) return held as Prefs
  const made: Prefs = {}
  prefs[key] = made
  return made
}

export async function markAgentProfile(profileDir: string): Promise<void> {
  const file = join(profileDir, 'Default', 'Preferences')
  let prefs: Prefs = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) prefs = parsed as Prefs
  } catch {
  }
  const profile = section(prefs, 'profile')
  const theme = section(section(prefs, 'browser'), 'theme')
  const already = profile['name'] === PROFILE_NAME && theme['user_color'] === THEME.user_color && theme['color_scheme'] === THEME.color_scheme
  if (already) return
  profile['name'] = PROFILE_NAME
  Object.assign(theme, THEME)
  await mkdir(join(profileDir, 'Default'), { recursive: true })
  await writeFile(file, JSON.stringify(prefs))
  flog('agent-browser', 'profile marked as the agent window')
}
