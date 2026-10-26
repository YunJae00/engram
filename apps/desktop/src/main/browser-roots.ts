import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface BrowserRoot { id: string; name: string; userData: string }

// Every Chromium-family browser keeps the same History and Bookmarks files in
// each profile folder, so one reader covers whichever ones the person uses.
export function chromiumRoots(): BrowserRoot[] {
  const home = homedir()
  const rows: [string, string, string][] = []
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    const roaming = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    rows.push(
      ['chrome', 'Chrome', join(local, 'Google', 'Chrome', 'User Data')],
      ['edge', 'Edge', join(local, 'Microsoft', 'Edge', 'User Data')],
      ['whale', 'Whale', join(local, 'Naver', 'Naver Whale', 'User Data')],
      ['brave', 'Brave', join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')],
      ['vivaldi', 'Vivaldi', join(local, 'Vivaldi', 'User Data')],
      ['chromium', 'Chromium', join(local, 'Chromium', 'User Data')],
      ['opera', 'Opera', join(roaming, 'Opera Software', 'Opera Stable')],
    )
  } else if (process.platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    rows.push(
      ['chrome', 'Chrome', join(support, 'Google', 'Chrome')],
      ['edge', 'Edge', join(support, 'Microsoft Edge')],
      ['whale', 'Whale', join(support, 'Naver', 'Whale')],
      ['brave', 'Brave', join(support, 'BraveSoftware', 'Brave-Browser')],
      ['arc', 'Arc', join(support, 'Arc', 'User Data')],
      ['vivaldi', 'Vivaldi', join(support, 'Vivaldi')],
      ['chromium', 'Chromium', join(support, 'Chromium')],
      ['opera', 'Opera', join(support, 'com.operasoftware.Opera')],
    )
  } else {
    const config = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config')
    rows.push(
      ['chrome', 'Chrome', join(config, 'google-chrome')],
      ['edge', 'Edge', join(config, 'microsoft-edge')],
      ['whale', 'Whale', join(config, 'naver-whale')],
      ['brave', 'Brave', join(config, 'BraveSoftware', 'Brave-Browser')],
      ['vivaldi', 'Vivaldi', join(config, 'vivaldi')],
      ['chromium', 'Chromium', join(config, 'chromium')],
      ['opera', 'Opera', join(config, 'opera')],
    )
  }
  return rows.map(([id, name, userData]) => ({ id, name, userData })).filter(root => existsSync(root.userData))
}

// A browser's profile folders: Default and Profile N, or the folder itself
// where a browser keeps its one profile there.
export function profileDirs(userData: string): string[] {
  let names: string[] = []
  try { names = readdirSync(userData, { withFileTypes: true }).filter(dir => dir.isDirectory() && /^(Default|Profile \d+)$/.test(dir.name)).map(dir => dir.name) } catch { return [] }
  return names.length ? names : existsSync(join(userData, 'History')) || existsSync(join(userData, 'Bookmarks')) ? ['.'] : []
}

// Firefox keeps history and bookmarks together, one places.sqlite per profile.
export function firefoxPlaces(): string[] {
  const home = homedir()
  const folder = process.platform === 'win32' ? join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox', 'Profiles')
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')
    : join(home, '.mozilla', 'firefox')
  try {
    return readdirSync(folder, { withFileTypes: true }).filter(dir => dir.isDirectory()).map(dir => join(folder, dir.name, 'places.sqlite')).filter(file => existsSync(file))
  } catch { return [] }
}
