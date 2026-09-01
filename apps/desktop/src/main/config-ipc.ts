import { createEngine, ENGINE_ORDER } from 'core'
import { app, dialog, ipcMain, shell } from 'electron'
import { cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import type { AppSettingsDto, DiagnosticsDto } from '../shared/types.js'
import { broadcast } from './ipc.js'
import { detectApiKeyEnv } from './installer.js'
import { loadSettings, saveSettings } from './settings.js'
import { getSyncStatus } from './team.js'
import { binaryProvider, type VaultContext } from './vault.js'

// Settings are app-level, not vault-level — the onboarding and quick-capture
// windows read them (language, shortcut) before any vault is booted, so these
// handlers must exist from registerBaseIpc, not from bootVault.
// Choosing another brain must reach the engine list at once, not at the
// next scheduled detection; the vault owner installs this when it is up.
let onBrainChoice: (() => void) | null = null
export function setBrainChoiceHook(hook: () => void): void {
  onBrainChoice = hook
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', () => loadSettings())

  ipcMain.handle('settings:set', async (_e, settings: AppSettingsDto) => {
    // The search shape is learned elsewhere and is not the settings screen's
    // to clear: a save from a form that never showed it must not wipe it.
    const held = await loadSettings()
    await saveSettings({
      ...held,
      ...settings,
      searchTemplate: settings.searchTemplate ?? held.searchTemplate,
      agentBrowser: settings.agentBrowser ?? held.agentBrowser,
    })
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.autoStart })
    if (settings.defaultEngine !== held.defaultEngine) onBrainChoice?.()
    // Watch folders / shortcut / schedule re-arm on next launch (kept simple).
    // Live surfaces (the agent terminal's colours) restyle immediately.
    broadcast({ type: 'settings:changed', settings })
  })

}

export function registerConfigIpc(ctx: VaultContext): void {
  ipcMain.handle('diagnostics:info', async (): Promise<DiagnosticsDto> => {
    const engines: DiagnosticsDto['engines'] = []
    for (const id of ENGINE_ORDER) {
      try {
        const detection = await createEngine(id).detect()
        engines.push({
          id,
          ...detection,
          diagnosis: detection.installed
            ? detection.loggedIn
              ? 'signed in'
              : 'not signed in — Settings → Brain'
            : 'not part of this build',
        })
      } catch {
        engines.push({ id, installed: false, loggedIn: false, diagnosis: 'could not be asked' })
      }
    }
    return {
      engines,
      sync: await getSyncStatus(ctx),
      apiKeyEnvWarnings: detectApiKeyEnv(),
      bundledGit: binaryProvider().hasBundledGit(),
      logsDir: join(ctx.paths.views, 'logs'),
    }
  })

  ipcMain.handle('logs:export', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const target = join(result.filePaths[0], `engram-logs-${Date.now()}`)
    await cp(join(ctx.paths.views, 'logs'), join(target, 'librarian'), { recursive: true }).catch(() => undefined)
    await cp(join(app.getPath('userData'), 'logs'), join(target, 'field'), { recursive: true }).catch(() => undefined)
    await cp(join(app.getPath('userData'), 'engine-pids.json'), join(target, 'engine-pids.json')).catch(() => undefined)
    const versions = [
      `engram ${app.getVersion()}`,
      `electron ${process.versions.electron}`,
      `chrome ${process.versions.chrome}`,
      `node ${process.versions.node}`,
      `os ${process.platform} ${os.release()}`,
      `crash dumps: ${app.getPath('crashDumps')}`,
    ].join('\n')
    await writeFile(join(target, 'versions.txt'), versions).catch(() => undefined)
    void shell.openPath(target)
    return target
  })
}
