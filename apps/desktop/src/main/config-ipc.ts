import { createEngine, ENGINE_ORDER, REASONING_EFFORTS, type ReasoningEffort } from 'core'
import { app, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import type { AppSettingsDto, DiagnosticsDto } from '../shared/types.js'
import { broadcast } from './ipc.js'
import { detectApiKeyEnv } from './installer.js'
import { loadSettings, updateSettings } from './settings.js'
import { getSyncStatus } from './team.js'
import { binaryProvider, type VaultContext } from './vault.js'
import { stopDesktopControl } from './desktop-control.js'
import { aiSelection } from './ai-selection.js'
import { workMapSettingChanged } from './work-map-job.js'
import { cancelWorkInterview } from './work-interview.js'

// Settings are app-level, not vault-level — the onboarding and quick-capture
// windows read them (language, shortcut) before any vault is booted, so these
// handlers must exist from registerBaseIpc, not from bootVault.
// Choosing another brain must reach the engine list at once, not at the
// next scheduled detection; the vault owner installs this when it is up.
let onBrainChoice: (() => void | Promise<void>) | null = null
export function setBrainChoiceHook(hook: () => void | Promise<void>): void {
  onBrainChoice = hook
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('ai:selection', async (_event, scope: unknown, selection: unknown) => {
    if (typeof scope !== 'string' || !/^(filing|cosmos|panel|bot-[a-zA-Z0-9_-]{1,100})$/.test(scope)) throw new Error('Invalid AI scope')
    const value = selection as { engine?: unknown; model?: unknown; effort?: unknown } | null
    if (!value || !['claude', 'codex'].includes(String(value.engine)) || typeof value.model !== 'string' || value.model.length > 200) throw new Error('Invalid AI selection')
    if (value.effort !== undefined && !REASONING_EFFORTS.includes(value.effort as ReasoningEffort)) throw new Error('Invalid reasoning effort')
    const chosen = { engine: value.engine as 'claude' | 'codex', model: value.model.trim(), ...(value.effort ? { effort: value.effort as ReasoningEffort } : {}) }
    const settings = await updateSettings(held => ({ ...held, aiSelections: { ...held.aiSelections, filing: aiSelection(held, 'filing'), [scope]: chosen } }))
    broadcast({ type: 'settings:changed', settings })
    if (scope === 'filing') await onBrainChoice?.()
  })

  ipcMain.handle('settings:set', async (_e, settings: Partial<AppSettingsDto>) => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings')
    if (settings.defaultEngine !== undefined && !['claude', 'codex'].includes(settings.defaultEngine)) throw new Error('Invalid AI provider')
    if (settings.theme !== undefined && !['system', 'light', 'dark'].includes(settings.theme)) throw new Error('Invalid appearance')
    for (const key of ['autoStart', 'computerUse', 'workMap'] as const) if (settings[key] !== undefined && typeof settings[key] !== 'boolean') throw new Error('Invalid setting: ' + key)
    for (const key of ['searchTemplate', 'agentBrowser', 'claudeModel', 'codexModel', 'semanticModel'] as const) if (settings[key] !== undefined && typeof settings[key] !== 'string') throw new Error('Invalid setting: ' + key)
    if (settings.teamSync !== undefined && !['auto', 'manual'].includes(settings.teamSync)) throw new Error('Invalid sync setting')
    for (const effort of [settings.claudeEffort, settings.codexEffort]) if (effort !== undefined && !REASONING_EFFORTS.includes(effort)) throw new Error('Invalid reasoning effort')
    const change = Object.fromEntries(Object.entries(settings).filter(([key, value]) => key !== 'recordTasks' && (value !== undefined || key === 'claudeEffort' || key === 'codexEffort'))) as Partial<AppSettingsDto>
    const held = await loadSettings()
    if (settings.workMap === false) { workMapSettingChanged(false); if (held.workMap) cancelWorkInterview() }
    if (settings.computerUse === false && held.computerUse) stopDesktopControl('Computer use was turned off in Settings.')
    const saved = await updateSettings(latest => ({
      ...latest,
      ...change,
      aiSelections: { ...latest.aiSelections, filing: aiSelection(latest, 'filing') },
    }))
    if (settings.theme !== undefined) nativeTheme.themeSource = saved.theme
    if (settings.autoStart !== undefined && app.isPackaged) app.setLoginItemSettings({ openAtLogin: saved.autoStart })
    // Watch folders / shortcut / schedule re-arm on next launch (kept simple).
    // Live surfaces (the agent terminal's colours) restyle immediately.
    broadcast({ type: 'settings:changed', settings: saved })
    if (settings.workMap === true && !held.workMap) workMapSettingChanged(true)
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
