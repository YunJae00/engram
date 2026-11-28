import { homedir } from 'node:os'
import { join } from 'node:path'

const home = homedir()
export const runnerUserData = process.env['ENGRAM_USERDATA'] || (process.platform === 'win32'
  ? join(process.env['APPDATA'] || join(home, 'AppData', 'Roaming'), 'desktop')
  : process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'desktop')
    : join(process.env['XDG_CONFIG_HOME'] || join(home, '.config'), 'desktop'))
export const app = { getPath: (name: string) => name === 'userData' ? runnerUserData : home }
export const net = { fetch: globalThis.fetch }
export const safeStorage = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => 'basic_text',
  encryptString: () => { throw new Error('Secure key storage requires the desktop app.') },
  decryptString: () => { throw new Error('Secure key storage requires the desktop app.') },
}
