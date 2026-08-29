import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { flog } from './flog.js'

// The agent window is the person's browser wearing Engram's colours: a dark
// ink frame and a profile named for the app, so a window the comet opened is
// never mistaken for one the person did. Both live in the profile's own
// preferences, which the browser reads at launch - and rewrites on exit, and
// a carried-across session replaces wholesale - so they are put back before
// every launch.
const PROFILE_NAME = 'Engram'
// The app's ink, as the browser stores a colour: ARGB in a signed 32-bit int.
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
    // A fresh profile, or one the browser has not written yet: start from nothing.
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
