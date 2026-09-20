import { ipcMain } from 'electron'
import { engineBackoff } from 'core'
import { accountProfiles, addAccountProfile, selectAccountProfile } from './account-profiles.js'
import { cloudEngine } from './engine-cloud.js'
import { desktopOwner } from './desktop-access.js'
import { broadcast, markEngineOk } from './engine-health.js'
import type { AccountProfileState, AccountProvider } from '../shared/account-profiles.js'

export function registerAccountIpc(changed: () => Promise<void>): void {
  const handle = (name: string, action: (...args: never[]) => unknown) => ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== desktopOwner()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Account settings require the main window.')
    return action(...args as never[])
  })
  handle('accounts:list', () => accountProfiles())
  handle('accounts:states', async () => {
    const profiles = accountProfiles(), rows = [
      { id: 'system', provider: 'claude' as const, name: 'System account' },
      { id: 'system', provider: 'codex' as const, name: 'System account' }, ...profiles.profiles,
    ]
    const result: AccountProfileState[] = []
    for (let at = 0; at < rows.length; at += 2) result.push(...await Promise.all(rows.slice(at, at + 2).map(async row => {
      const detection = await cloudEngine(row.provider, row.id).detect().catch(() => ({ installed: true, loggedIn: false, conclusive: false }))
      return { ...row, ...detection, selected: profiles.selected[row.provider] === row.id }
    })))
    return result
  })
  handle('accounts:add', async (provider: AccountProvider, name: string) => {
    const next = await addAccountProfile(provider, name)
    broadcast({ type: 'accounts:changed', accounts: next }); return next
  })
  handle('accounts:use', async (provider: AccountProvider, id: string) => {
    await selectAccountProfile(provider, id)
    markEngineOk(provider)
    engineBackoff.noteOk()
    broadcast({ type: 'accounts:changed', accounts: accountProfiles() })
    void changed()
  })
}
