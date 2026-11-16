import { preferences, readAudit, type PreferenceHost, type Preferences } from 'core'
import { app, nativeTheme } from 'electron'
import { basename, join } from 'node:path'
import { setActivityWatchEnabled } from './activity-watch.js'
import { reviewRuleInput, type ApprovalsStore } from './approvals.js'
import { writeLogs } from './config-ipc.js'
import { stopDesktopControl } from './desktop-control.js'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'
import { answerHabit, appUse, habitDrafts, setAppUse } from './habits-ipc.js'
import { updateSettings, type AppSettings } from './settings.js'
import { connectGithub, disconnectGithub, hasBackup, performSync, startAutoSync } from './team.js'
import type { VaultContext } from './vault.js'
import { deskSettingChanged, refreshWorkMap, workMapSettingChanged } from './work-map-job.js'

// What the Settings page no longer shows is asked for in chat (core preferences-tools.ts decides what is
// said and what needs a yes). This is only the hands: each function is what the removed row's switch did.

const save = async (change: Partial<AppSettings>): Promise<AppSettings> => {
  const settings = await updateSettings(held => ({ ...held, ...change }))
  broadcast({ type: 'settings:changed', settings })
  return settings
}

export function preferenceHost(ctx: VaultContext, approvals: Pick<ApprovalsStore, 'reviewRules' | 'addReviewRule' | 'removeReviewRule'>): PreferenceHost {
  return {
    autoStart: async on => {
      const settings = await save({ autoStart: on })
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.autoStart })
    },
    learning: async (source, on) => {
      if (source === 'activity') { await setActivityWatchEnabled(on); return }
      if (source === 'places') {
        if (!on) workMapSettingChanged(false)
        await save({ workMap: on })
        if (on) workMapSettingChanged(true)
        return
      }
      await save(source === 'files' ? { workFiles: on } : { workApps: on })
      if (on) deskSettingChanged()
    },
    rescanWork: async () => { void refreshWorkMap(ctx).catch(error => flog('preferences', error)) },
    apps: async () => (await appUse(ctx)).map(one => ({ app: one.app, label: one.label, on: one.on })),
    setApp: (name, label, on) => setAppUse(name, label, on),
    habits: async () => (await habitDrafts(ctx)).map(one => ({ key: one.key, title: one.title })),
    answerHabit: async (key, keep) => { await answerHabit(ctx, key, keep) },
    reviewRules: async () => (await approvals.reviewRules()).map(rule => ({ kind: rule.kind, target: rule.target })),
    setReviewRule: async (kind, site, on) => {
      const rule = reviewRuleInput({ kind, target: site })
      await (on ? approvals.addReviewRule(rule) : approvals.removeReviewRule(rule))
    },
    audit: day => readAudit(ctx.paths, day),
    // No folder picker: the person's Downloads, or beside the app's own data when that has been moved (tests, dev).
    exportLogs: async () => basename(await writeLogs(ctx, process.env['ENGRAM_USERDATA'] ? join(app.getPath('userData'), 'exports') : app.getPath('downloads'))),
    backup: {
      available: () => ctx.git !== null,
      connected: () => hasBackup(ctx),
      connect: url => connectGithub(ctx, url).catch(() => ({ ok: false })),
      disconnect: () => disconnectGithub(ctx),
      now: async () => { await performSync(ctx) },
      auto: async on => { await save({ teamSync: on ? 'auto' : 'manual' }); startAutoSync(ctx, on) },
    },
    stopComputerControl: () => stopDesktopControl(),
    theme: async theme => { nativeTheme.themeSource = (await save({ theme })).theme },
  }
}

export const preferencesChat = (ctx: VaultContext, approvals: Parameters<typeof preferenceHost>[1]): Preferences => preferences(preferenceHost(ctx, approvals))

// Whether a turn is the person's own typed message, the only thing read as a preference sentence.
// The task runner hands over every message with a turn of its own (its hold and its budget), so a turn being
// there says nothing: only its continuation, team report and re-check turns are the runner's own words.
export const isPersonSentence = (request: { scheduled?: boolean; attachments?: readonly unknown[] }, turn?: { quiet?: boolean; report?: true; verification?: unknown }, recovery?: string, routine?: unknown): boolean =>
  !recovery && !routine && !turn?.quiet && !turn?.report && !turn?.verification && !request.scheduled && !request.attachments?.length
