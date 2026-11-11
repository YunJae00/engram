import { describe, expect, it } from 'vitest'
import { en, followSettings, t, type StringKey } from '../src/renderer/src/i18n'
import { ko4 } from '../src/renderer/src/i18n-ko-4'
import { connectionLabel } from '../src/renderer/src/lib/connectionStatus'

const ENGLISH: Record<string, string> = {
  'composer.attachedFiles': 'Attached files',
  'composer.appsNamed': 'Apps named',
  'composer.add': 'Add to conversation',
  'composer.actions': 'Conversation actions',
  'composer.attach': 'Attach files',
  'composer.attachHint': 'Attach files · up to 8 files, 20 MB each',
  'composer.apps': 'Apps',
  'composer.queue': 'Queue message',
  'composer.queueHint': 'Send after this reply',
  'composer.attaching': 'Attaching files…',
  'composer.attachLimit': 'Attach up to {count} files per message.',
  'welcome.placeholder': 'Ask Engram…',
  'welcome.openWeb': 'Open the page panel',
  'model.systemAccount': 'System account',
  'model.needsAttention': 'Needs attention',
  'model.effortNone': 'None',
  'model.effortMinimal': 'Minimal',
  'model.effortLow': 'Low',
  'model.effortMedium': 'Medium',
  'model.effortHigh': 'High',
  'model.effortXhigh': 'Extra high',
  'model.effortMax': 'Max',
  'model.effortUltra': 'Ultra',
  'model.effortAuto': 'Auto',
  'model.savedSelection': 'Saved selection',
  'model.limitUnavailable': 'Unavailable',
  'model.percentLeft': '{percent}% left',
  'model.resets': ' · Resets {time}',
  'model.checkingLimits': 'Checking limits…',
  'model.limitsUnavailable': 'Limits unavailable',
  'model.choose': 'Choose provider and model',
  'model.loadingSelection': 'Loading model selection',
  'model.openSettings': 'Open AI settings',
  'model.menu': 'Provider and model',
  'model.headingSession': 'This session',
  'model.headingFiling': 'Filing provider',
  'model.headingConversation': 'This conversation',
  'model.headingNew': 'New conversations',
  'model.connectInSettings': 'Connect in settings',
  'model.setUpInSettings': 'Set up in settings',
  'model.connect': 'Connect',
  'model.updating': 'Updating models…',
  'model.loading': 'Loading models…',
  'model.retry': 'Models unavailable · Retry',
  'model.effortHeading': 'Reasoning effort',
  'model.manageAccounts': 'Manage {provider} accounts',
  'model.aiSettings': 'AI settings',
  'model.providerModels': '{provider} models',
  'model.accounts': ' · Accounts',
  'model.loadFailed': 'Could not load settings. Open AI settings to retry.',
  'model.checkFailed': 'Could not check connections. Open AI settings to retry.',
  'model.saveFailed': 'Could not save your selection. Try again.',
  'connection.checking': 'Checking connection…',
  'connection.notInstalled': 'Not installed',
  'connection.runtimeUnavailable': 'Runtime unavailable',
  'connection.reconnect': 'Reconnect required',
  'connection.unverified': 'Connection not verified',
  'connection.notConnected': 'Not connected',
  'connection.limited': 'Request limited · Retry check',
  'connection.outage': 'Not answering on its side',
  'connection.attention': 'Connection needs attention',
  'connection.connected': 'Connected',
}

const ALLOW = new Set([
  'Engram', 'Claude', 'ChatGPT', 'Codex', 'OpenAI', 'Gemini', 'Cosmos', 'Orbit', 'GitHub', 'Obsidian',
  'Chrome', 'Edge', 'Brave', 'Windows', 'Mac', 'MCP', 'CLI', 'API', 'URL', 'JSON',
  'PNG', 'JPG', 'JPEG', 'PDF', 'Cmd', 'Ctrl', 'Shift', 'Alt', 'Esc', 'Enter',
])
function isOffending(text: string): boolean {
  let rest = text.replace(/https?:\/\/\S+/g, ' ').replace(/(?:^|\s)(?:~?\/|[A-Za-z]:\\)\S+/g, ' ')
  for (const phrase of ['Claude Desktop', 'Claude Code']) rest = rest.split(phrase).join(' ')
  rest = rest.replace(/[A-Za-z]+/g, token => (ALLOW.has(token) ? ' ' : token))
  return /[A-Za-z]{3,}/.test(rest)
}
const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
const keys = Object.keys(ENGLISH) as StringKey[]
const ko = ko4 as Partial<Record<StringKey, string>>

async function language(uiLanguage: 'ko' | 'en') {
  await followSettings({
    onEvent: () => () => undefined,
    settingsGet: async () => ({ uiLanguage }),
  } as unknown as Parameters<typeof followSettings>[0])
}

describe('bot surface strings', () => {
  it('bot surface keys keep the English text', () => {
    for (const key of keys) {
      expect(en[key], key).toBe(ENGLISH[key])
      expect(key in ko4, key).toBe(true)
    }
  })

  it('every bot surface ko value is Korean and passes the ui-korean rule', () => {
    for (const key of keys) {
      const value = ko[key]!
      expect(value, key).toMatch(/[\uAC00-\uD7A3]/)
      expect(placeholders(value), key).toEqual(placeholders(en[key]))
      expect(isOffending(value.replace(/\{\w+\}/g, '1')), key).toBe(false)
      expect(value, key).not.toMatch(/\{\w+\}(이|가|을|를|은|는|과|와|으로|로)/)
    }
  })

  it('connection labels and effort names follow the UI language', async () => {
    const connected = { installed: true, loggedIn: true, conclusive: true }
    const cases: [Parameters<typeof connectionLabel>[0], string, StringKey][] = [
      [undefined, 'codex', 'connection.checking'],
      [{ ...connected, installed: false }, 'claude', 'connection.notInstalled'],
      [{ ...connected, installed: false }, 'codex', 'connection.runtimeUnavailable'],
      [{ ...connected, healthy: false, healthReason: 'auth' }, 'codex', 'connection.reconnect'],
      [{ ...connected, conclusive: false }, 'codex', 'connection.unverified'],
      [{ ...connected, loggedIn: false }, 'codex', 'connection.notConnected'],
      [{ ...connected, healthy: false, healthReason: 'quota' }, 'codex', 'connection.limited'],
      [{ ...connected, healthy: false, healthReason: 'outage' }, 'codex', 'connection.outage'],
      [{ ...connected, healthy: false }, 'codex', 'connection.attention'],
      [connected, 'codex', 'connection.connected'],
    ]
    const efforts: StringKey[] = ['model.effortNone', 'model.effortMinimal', 'model.effortLow', 'model.effortMedium', 'model.effortHigh', 'model.effortXhigh', 'model.effortMax', 'model.effortUltra', 'model.effortAuto']
    try {
      await language('ko')
      for (const [state, provider, key] of cases) expect(connectionLabel(state, provider), key).toBe(ko[key])
      for (const key of efforts) expect(t(key), key).toBe(ko[key])
    } finally {
      await language('en')
    }
    for (const [state, provider, key] of cases) expect(connectionLabel(state, provider), key).toBe(ENGLISH[key])
    for (const key of efforts) expect(t(key), key).toBe(ENGLISH[key])
  })
})
