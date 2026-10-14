import type { AgentTool } from 'core'

interface Consent {
  enabled(): Promise<boolean>
  enable(): Promise<void>
  ask?: (what: { words: string; url: string }) => Promise<'approve' | 'always' | 'cancel' | 'later'>
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
  return tools.map(tool => ({
    ...tool,
    run: async (args, context) => { await allow(context.signal); return tool.run(args, context) },
    ...(tool.runRich ? { runRich: async (args, context) => { await allow(context.signal); return tool.runRich!(args, context) } } : {}),
  }))
}

export const DESKTOP_CONSENT_CONTEXT = 'Desktop tools can operate installed apps, including chat apps, using their actual windows. If Control apps is off, the first tool requests explicit approval before accessing any app. Do not claim desktop tools are unavailable when they are offered. If the person requests a desktop app, use its launcher/window rather than its website. Never substitute the website without asking. Sign-in stays manual; do not read local account databases or automate login. Only report sessions that were actually observed.'
