import type { AgentTool } from 'core'
import { systemVolumeTool } from './desktop-volume.js'

type AgentToolContext = Parameters<AgentTool['run']>[1]
export interface DesktopActionContext extends AgentToolContext {
  approveComputerControl?(lane: string): Promise<boolean>
  approveAppAction?(app: string, control: string, snapshot: string, scope?: string): Promise<boolean>
}

interface Consent {
  enabled(): Promise<boolean>
  enable(): Promise<void>
  ask?: (what: { words: string; url: string; scope?: string }) => Promise<'approve' | 'always' | 'cancel' | 'later'>
}

export function desktopOptIn(tools: AgentTool[], consent: Consent): AgentTool[] {
  let refused = false
  const allow = async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (await consent.enabled()) return
    if (refused || !consent.ask) throw new Error('App control is off. Enable Control apps in Settings. Do not replace a requested desktop app with its website.')
    const answer = await consent.ask({ words: 'Enable app control until turned off in Settings? App text and screenshots go to your AI. Esc stops; sign-in stays manual.', url: 'engram://settings/computer-use' })
    signal?.throwIfAborted()
    if (answer !== 'approve') { refused = true; throw new Error('App control was not approved. No app was opened or read. Ask the person before using a website instead.') }
    await consent.enable()
    signal?.throwIfAborted()
  }
  const scoped = (context: AgentToolContext): DesktopActionContext => ({
    ...context,
    approveComputerControl: async lane => {
      context.signal?.throwIfAborted()
      const answer = await consent.ask?.({ words: 'Allow foreground computer control for this turn? Esc or Stop ends control.', url: `engram://computer-control/${encodeURIComponent(lane)}` })
      context.signal?.throwIfAborted()
      return answer === 'approve' && await consent.enabled()
    },
    approveAppAction: async (app, control, _snapshot, scope) => {
      context.signal?.throwIfAborted()
      const answer = await consent.ask?.({ words: `Allow "${control.slice(0, 60)}" in "${app.slice(0, 60)}"? This may send or change data.`, url: `engram://app/${encodeURIComponent(app)}#${encodeURIComponent(control)}`, ...(scope ? { scope } : {}) })
      context.signal?.throwIfAborted()
      return answer === 'approve' && await consent.enabled()
    },
  })
  const wrapped: AgentTool[] = tools.map(tool => ({
    ...tool,
    run: async (args, context) => { await allow(context.signal); return tool.run(args, scoped(context)) },
    ...(tool.runRich ? { runRich: async (args, context) => { await allow(context.signal); return tool.runRich!(args, scoped(context)) } } : {}),
  }))
  const volume = systemVolumeTool()
  if (process.platform !== 'darwin' || !tools.some(tool => tool.name === 'list_apps')) return [...wrapped, volume]
  return [...wrapped, volume, {
    name: 'permission_state',
    description: PERMISSION_STATE_DESCRIPTION,
    argsSchema: { type: 'object', properties: {}, additionalProperties: false },
    // Loaded lazily so this module stays free of electron and the helper until the read is asked for.
    run: async (args, context) => {
      const [{ permissionStateTool }, { catalogHost }] = await Promise.all([import('./desktop-permission-state.js'), import('./desktop-access.js')])
      return permissionStateTool(catalogHost).run(args, context)
    },
  }]
}

export const PERMISSION_STATE_DESCRIPTION = 'Reports which macOS privacy permissions Engram has right now (Accessibility, Screen Recording, Input Monitoring) and what each is needed for. Read-only: needs no app control approval, opens no app or window, and never asks for or changes a permission. Call it whenever the person asks which permissions are on, and answer from its result.'

export const DESKTOP_CONSENT_CONTEXT = 'Desktop tools can operate installed apps, including chat apps, using their actual windows. If Control apps is off, the first tool requests explicit approval before accessing any app. Do not claim desktop tools are unavailable when they are offered. If the person requests a desktop app, use its launcher/window rather than its website. Never substitute the website without asking. Sign-in stays manual; do not read local account databases or automate login. Only report sessions that were actually observed. To answer which macOS permissions Engram has, call permission_state; it needs no app control approval. To read or set the output volume or mute, call system_volume; it needs no app control approval. Report the volume it read back.'
