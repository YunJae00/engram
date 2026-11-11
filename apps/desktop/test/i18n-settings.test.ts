import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettingsDto } from '../src/shared/types.js'
import type { DesktopControlStatusDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, settings: unknown) => Promise<void>>(),
  load: vi.fn(), save: vi.fn(), stop: vi.fn(), broadcast: vi.fn(), changed: vi.fn(), nativeTheme: { themeSource: 'system' },
  app: { isPackaged: false, setLoginItemSettings: vi.fn() }, queue: Promise.resolve(), updates: 0,
}))
vi.mock('core', () => ({ createEngine: vi.fn(), ENGINE_ORDER: [], REASONING_EFFORTS: ['low', 'medium', 'high'] }))
vi.mock('electron', () => ({ app: fake.app, nativeTheme: fake.nativeTheme, dialog: {}, shell: {}, ipcMain: { handle: (name: string, handler: (event: unknown, settings: unknown) => Promise<void>) => fake.handlers.set(name, handler) } }))
vi.mock('../src/main/ipc.js', () => ({ broadcast: fake.broadcast }))
vi.mock('../src/main/installer.js', () => ({ detectApiKeyEnv: vi.fn() }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: fake.load, updateSettings: (change: (settings: AppSettingsDto) => AppSettingsDto) => {
  fake.updates++
  const next = fake.queue.then(async () => { const value = change(await fake.load()); await fake.save(value); return value })
  fake.queue = next.then(() => undefined, () => undefined)
  return next
} }))
vi.mock('../src/main/team.js', () => ({ getSyncStatus: vi.fn() }))
vi.mock('../src/main/vault.js', () => ({ binaryProvider: vi.fn() }))
vi.mock('../src/main/desktop-control.js', () => ({ stopDesktopControl: fake.stop }))
vi.mock('../src/renderer/src/lib/desktopSession.js', () => ({ desktopError: String, stopComputerControl: vi.fn(), useDesktopSession: vi.fn() }))
import { registerSettingsIpc, setBrainChoiceHook } from '../src/main/config-ipc.js'
import { en, followSettings, t, type StringKey } from '../src/renderer/src/i18n'
import { ko3 } from '../src/renderer/src/i18n-ko-3'
import { ko4 } from '../src/renderer/src/i18n-ko-4'
import { computerStateLabel } from '../src/renderer/src/components/ComputerStatus'
import { LEARNING_SOURCES } from '../src/renderer/src/components/LearningSources'

const ENGLISH: Record<string, string> = {
  'settingsUi.updateCheckFailed': 'Could not check for updates. Try again.',
  'settingsUi.statusRetrying': 'Could not check status. Retrying…',
  'settingsUi.close': 'Close settings',
  'settingsUi.general': 'General',
  'settingsUi.appearance': 'Appearance',
  'settingsUi.app': 'App',
  'settingsUi.newComet': 'New Comet anywhere',
  'settingsUi.newCometHint': 'Starts a conversation next to the pointer, from any app.',
  'settingsUi.keySpace': 'Space',
  'settingsUi.aiSection': 'AI connection',
  'settingsUi.ai': 'AI & accounts',
  'settingsUi.memorySection': 'Memory and data',
  'settingsUi.memory': 'Memory & data',
  'settingsUi.learnTitle': 'Learn from this computer',
  'settingsUi.learnNote': 'Only names, titles and notifications are kept, as notes your AI can read. Pages and files are never opened.',
  'settingsUi.activityFailed': 'Could not save app activity. Try again.',
  'settingsUi.yourData': 'Your data',
  'settingsUi.auditHint': 'Every action and approval, kept on this computer.',
  'settingsUi.auditFailed': 'Could not open the activity log.',
  'settingsUi.open': 'Open',
  'settingsUi.githubHint': 'Keep a copy in a private GitHub repository.',
  'settingsUi.setUp': 'Set up',
  'settingsUi.advanced': 'Advanced',
  'settingsUi.about': 'About',
  'settingsUi.support': 'Support',
  'settingsUi.logs': 'Logs',
  'settingsUi.logsHint': 'Save recent logs to a file to send when something goes wrong.',
  'settingsUi.saving': 'Saving…',
  'settingsUi.exportLogs': 'Export logs',
  'settingsUi.saved': 'Saved',
  'settingsUi.done': 'Done',
  'settingsUi.sections': 'Settings sections',
  'settingsUi.themeSystem': 'System',
  'settingsUi.themeLight': 'Light',
  'settingsUi.themeDark': 'Dark',
  'settingsUi.language': 'Interface language',
  'settingsUi.langSystem': 'System',
  'settingsUi.langKo': 'Korean',
  'settingsUi.langEn': 'English',
  'settingsUi.checking': 'Checking…',
  'settingsUi.unavailableBuild': 'Unavailable on this build',
  'settingsUi.ready': 'Ready',
  'settingsUi.computerUse': 'Computer use',
  'settingsUi.computerApps': 'Apps on this computer',
  'settingsUi.computerHint': 'Engram uses your mouse and keyboard when a task needs an app. Move the mouse to pause, press Esc to stop. Passwords and sign-in pages stay off limits.',
  'settingsUi.dismiss': 'Dismiss',
  'settingsUi.stopControl': 'Stop computer control',
  'settingsUi.theComet': 'The comet',
  'settingsUi.controlling': '{who} is controlling your computer',
  'settingsUi.aboutToUse': '{who} is about to use your computer',
  'settingsUi.attention': 'Your attention is needed',
  'settingsUi.tookOver': 'You took over',
  'settingsUi.controlOff': 'Computer control is off',
  'settingsUi.loading': 'Loading…',
  'settingsUi.devTools': 'Developer tools',
  'settingsUi.developers': 'Developers',
  'settingsUi.devOffHint': 'Turning off stops development tasks, not their files or history.',
  'settingsUi.rememberSessions': 'Remember coding sessions in Cosmos',
  'settingsUi.savedDecisions': 'Saved edit decisions',
  'settingsUi.savedDecisionsHint': 'Applies only to matching inputs and content. Commands and sensitive actions still ask outside full access.',
  'settingsUi.removedRepo': 'Removed repository',
  'settingsUi.remove': 'Remove',
  'settingsUi.providerIntegrations': 'Provider integrations',
  'settingsUi.providerHooks': 'Provider hooks & project settings',
  'settingsUi.providerHooksHint': 'New full-access development tasks only. Hooks, skills and MCP servers can run commands without Engram approval. Account connections stay with your provider.',
  'settingsUi.checkConnectionsFailed': 'Could not check connections. Retry below.',
  'settingsUi.didNotFinish': 'That did not finish. Please try again.',
  'settingsUi.startingSignIn': 'Starting sign-in…',
  'settingsUi.finishSigningIn': 'Finish signing in in your browser',
  'settingsUi.signedInAccount': 'Signed in with your account',
  'settingsUi.runtimeTerms': 'Official runtime download. Anthropic’s terms apply.',
  'settingsUi.connectionOf': '{name} connection',
  'settingsUi.account': 'Account',
  'settingsUi.manage': 'Manage',
  'settingsUi.signIn': 'Sign-in',
  'settingsUi.openBrowser': 'Open browser',
  'settingsUi.cancel': 'Cancel',
  'settingsUi.disconnect': 'Disconnect',
  'settingsUi.retryConnection': 'Retry connection check',
  'settingsUi.connectName': 'Connect {name}',
  'settingsUi.defaults': 'Defaults',
  'settingsUi.newConvModel': 'New conversation model',
  'settingsUi.newConvHint': 'The AI a new conversation starts with.',
  'settingsUi.filingModel': 'Filing model',
  'settingsUi.filing': 'Filing & memory',
  'settingsUi.filingAnswered': 'The selected model answered.',
  'settingsUi.filingHint': 'Sorts what you keep into Cosmos.',
  'settingsUi.test': 'Test',
  'settingsUi.decisionConnection': 'Decision model connection',
  'settingsUi.retry': 'Retry',
  'settingsUi.startFresh': 'Start fresh',
  'settingsUi.startFreshHint': "Erase Engram's local data and set it up again. AI sign-ins stay.",
  'settingsUi.restarting': 'Restarting…',
  'settingsUi.reset': 'Reset…',
  'settingsUi.askFirst': 'Ask first',
  'settingsUi.allowAuto': 'Allow automatically',
  'settingsUi.typeSite': 'Type a site, such as example.com.',
  'settingsUi.notSiteAddress': '"{value}" is not a site address.',
  'settingsUi.notWebSite': '"{value}" is not a web site.',
  'settingsUi.autoReview': 'Automatic review',
  'settingsUi.removeTarget': 'Remove {target}',
  'settingsUi.siteFor': 'Site for {title}',
  'settingsUi.add': 'Add',
  'settingsUi.reviewNote': 'Before a bot submits a form on a site, Ask first sites always wait for you. Ask first wins when a site is in both lists.',
  'settingsUi.updateOpenFailed': 'Could not open the update. Try again.',
  'settingsUi.updateDownload': 'Update download',
  'settingsUi.opening': 'Opening…',
  'settingsUi.appHours': '{hours} h',
  'settingsUi.dayOne': '{count} day',
  'settingsUi.dayMany': '{count} days',
  'settingsUi.noteOne': '{count} notification',
  'settingsUi.noteMany': '{count} notifications',
  'settingsUi.lastMonth': '{usage} in the last 30 days',
  'settingsUi.saveSettingFailed': 'Could not save the setting.',
  'settingsUi.lookFailed': 'Could not look this time. Try again later.',
  'settingsUi.answerFailed': 'Could not save your answer.',
  'settingsUi.appsTitle': 'Apps Engram may use',
  'settingsUi.appsNote': 'Engram keeps what the apps turned on here show: their windows and their notifications. An app turned off is not recorded, learned from or worked in.',
  'settingsUi.noApps': 'No apps yet',
  'settingsUi.noAppsHint': 'Apps appear here as you use them while Engram is open.',
  'settingsUi.turnedOff': 'Turned off',
  'settingsUi.letUse': 'Let Engram use {app}',
  'settingsUi.showFewer': 'Show fewer',
  'settingsUi.showAll': 'Show all {count}',
  'settingsUi.fewer': 'Fewer',
  'settingsUi.all': 'All',
  'settingsUi.habitsTitle': 'Ways of working noticed',
  'settingsUi.habitsNote': 'Kept ones are how-tos your AI follows when the same job comes up.',
  'settingsUi.toCheck': '{count} to check',
  'settingsUi.nothingToCheck': 'Nothing to check',
  'settingsUi.isThisHow': 'Is this how you do it?',
  'settingsUi.habitsHint': 'When you go through the same apps for one job a few times, a how-to is drafted here.',
  'settingsUi.lookNow': 'Look now',
  'settingsUi.times': '{count} times',
  'settingsUi.howTo': 'How-to',
  'settingsUi.notRight': 'Not right',
  'settingsUi.keep': 'Keep',
  'settingsUi.readSettingsFailed': 'Could not read settings.',
  'settingsUi.browserReadFailed': 'Could not read the browser this time. Try again later.',
  'settingsUi.placesOn': '{count} places · {date}',
  'settingsUi.places': '{count} places',
  'settingsUi.learning': 'Learning…',
  'settingsUi.updating': 'Updating…',
  'settingsUi.updatePlaces': 'Update work places',
  'settingsUi.srcWorkMap': 'Browser history, bookmarks and downloads',
  'settingsUi.srcWorkMapDetail': 'Site names, page titles and downloaded file names from the last 30 days.',
  'settingsUi.srcFiles': 'Recent files and folders',
  'settingsUi.srcFilesDetail': 'Names and locations of files you opened. Contents are not read.',
  'settingsUi.srcApps': 'Apps you use',
  'settingsUi.srcAppsDetail': 'App names and how often you use them.',
  'settingsUi.srcActivity': 'App activity while Engram is open',
  'settingsUi.srcActivityDetail': 'App names, window titles and notifications, kept while Engram runs.',
  'settingsUi.learnNoteLong': 'Pages and files are never opened. What you allow is saved as notes in your workspace, and your AI reads them to organize Cosmos.',
  'settingsUi.learnLegend': 'What Engram may learn from',
  'settingsUi.learnCompact': 'Names, window titles and notifications are saved and shared with your AI. Browser history: last 30 days. Pages and file contents are not read.',
  'settingsUi.manageAccounts': 'Manage accounts',
  'settingsUi.signInProgressFailed': 'Could not check sign-in progress. Reopen accounts to retry.',
  'settingsUi.accountProfiles': 'Account profiles',
  'settingsUi.providerAccounts': '{provider} accounts',
  'settingsUi.closeAccounts': 'Close accounts',
  'settingsUi.runningKeep': 'Running sessions keep their account. Selection applies to new tasks.',
  'settingsUi.updatingAccount': 'Updating account…',
  'settingsUi.selected': 'Selected',
  'settingsUi.usedBySession': 'Used by this session',
  'settingsUi.finishSignIn': 'Finish sign-in in your browser',
  'settingsUi.cancelSignIn': 'Cancel sign-in',
  'settingsUi.current': 'Current',
  'settingsUi.useAccount': 'Use account',
  'settingsUi.retryCheck': 'Retry check',
  'settingsUi.newAccountLabel': 'New account label',
  'settingsUi.accountPlaceholder': 'Personal, Work…',
  'settingsUi.addAccount': 'Add account',
  'settingsUi.signInOnce': 'Sign in once per account. Each account keeps its own limits and sessions.',
  'settingsUi.checkingAccountLimits': 'Checking account limits…',
  'settingsUi.percentRemaining': '{percent}% remaining',
  'settingsUi.windowRemaining': '{name} remaining',
  'settingsUi.resets': 'Resets {time}',
  'settingsUi.checked': 'Checked {time}',
  'settingsUi.usageLimits': 'Usage limits',
  'settingsUi.refreshUsage': 'Refresh {provider} usage',
  'settingsUi.checkingConnected': 'Checking connected accounts…',
  'settingsUi.connectToSeeLimits': 'Connect an AI account in settings to see its reported limits.',
  'settingsUi.clickManage': 'Click to manage accounts',
  'settingsUi.installFailed': 'Could not install Claude. Try again or open the official installation guide.',
  'settingsUi.downloadingVerifying': 'Downloading and verifying…',
  'settingsUi.installRuntime': 'Install Claude runtime',
  'settingsUi.guideFailed': 'Could not open the guide. Visit code.claude.com/docs/en/setup in your browser.',
  'settingsUi.installGuide': 'Official installation guide',
  'settingsUi.decisionModel': 'Decision model',
  'settingsUi.hintClaude': 'An address that speaks the Anthropic Messages API, such as a company gateway.',
  'settingsUi.hintCodex': 'An address that speaks the OpenAI Responses API, such as a company gateway.',
  'settingsUi.hintDecision': 'The decisions endpoint of a gateway or of the model vendor; used to pick the next step in an app quickly.',
  'settingsUi.shortKey': 'Use a company gateway or your own key instead of signing in.',
  'settingsUi.shortDecision': 'Optional. A fast model that picks the next step in an app.',
  'settingsUi.keySaved': 'API key saved · model tested when saved',
  'settingsUi.keyUnavailable': 'Key unavailable · reconnect',
  'settingsUi.keyHint': 'key {hint}',
  'settingsUi.apiKey': 'API key',
  'settingsUi.providerApiKey': '{name} API key',
  'settingsUi.keyAccountOnly': 'This key is used only for the selected account.',
  'settingsUi.creditsNote': 'A short model test may use API credits.',
  'settingsUi.decisionSent': 'App controls, visible text and your goal are sent to this address during app actions.',
  'settingsUi.convSent': 'Conversation content is sent to this address when you use this connection.',
  'settingsUi.address': 'Address',
  'settingsUi.enterKeyAgain': 'Enter the key again to change it',
  'settingsUi.pasteKey': 'Paste the key',
  'settingsUi.model': 'Model',
  'settingsUi.modelId': 'Model ID',
  'settingsUi.change': 'Change',
  'settingsUi.useApiKey': 'Use an API key',
  'settingsUi.clientCheckFailed': 'Could not check client configuration. Try again.',
  'settingsUi.statusReadFailed': 'Could not read connection status.',
  'settingsUi.connectionFailed': 'Connection failed. Try again.',
  'settingsUi.externalConnections': 'External connections',
  'settingsUi.otherApps': 'Other AI apps',
  'settingsUi.otherAppsHint': 'Let other AI apps use Engram’s memory, browser and file tools.',
  'settingsUi.shareTools': 'Share Engram tools',
  'settingsUi.shareToolsHint': 'This computer only · Off after restart',
  'settingsUi.shareToolsLabel': 'Share Engram tools for this app session',
  'settingsUi.off': 'Off',
  'settingsUi.working': 'Working',
  'settingsUi.liveOne': '{count} live session',
  'settingsUi.liveMany': '{count} live sessions',
  'settingsUi.readyToConnect': 'Ready to connect',
  'settingsUi.privacy': 'Each request needs your approval. Returned content is shared with that AI app. Its other tools and legacy memory connections are not controlled here.',
  'settingsUi.appsConfig': 'Apps and configuration',
  'settingsUi.reloadMcp': 'Reload the client’s MCP connection.',
  'settingsUi.verifyFailed': 'Could not verify. Retry below.',
  'settingsUi.configureFailed': 'Could not configure this client. Check that it is installed.',
  'settingsUi.connecting': 'Connecting…',
  'settingsUi.configured': 'Configured',
  'settingsUi.checkStatus': 'Check status',
  'settingsUi.mcpCopied': 'MCP configuration copied.',
  'settingsUi.copyConfig': 'Copy configuration',
  'settingsUi.sessionsStopped': 'Sessions stopped. Check any partial changes before retrying.',
  'settingsUi.stopSessions': 'Stop sessions',
}

const ALLOW = new Set([
  'Engram', 'Claude', 'ChatGPT', 'Codex', 'OpenAI', 'Gemini', 'Cosmos', 'Orbit', 'GitHub', 'Obsidian',
  'Chrome', 'Edge', 'Brave', 'Windows', 'Mac', 'MCP', 'CLI', 'API', 'URL', 'JSON',
  'PNG', 'JPG', 'JPEG', 'PDF', 'Cmd', 'Ctrl', 'Shift', 'Alt', 'Esc', 'Enter',
])
function isOffending(text: string): boolean {
  let rest = text.replace(/https?:\/\/\S+/g, ' ').replace(/(?:^|\s)(?:~?\/|[A-Za-z]:\\)\S+/g, ' ')
  for (const phrase of ['Claude Code', 'Claude Desktop']) rest = rest.split(phrase).join(' ')
  rest = rest.replace(/[A-Za-z]+/g, token => (ALLOW.has(token) ? ' ' : token))
  return /[A-Za-z]{3,}/.test(rest)
}
const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
const keys = Object.keys(ENGLISH) as StringKey[]
const ko = { ...ko3, ...ko4 } as Partial<Record<StringKey, string>>
const PLACEHOLDER_PARTICLE = /\{\w+\}["'”’]?(이|가|을|를|은|는|과|와|으로|로)([^(]|$)/
const COUNTER_PARTICLE = /\}(개|초|자)(이|을|은|과|으로)([^가-힣]|$)|\}(건|번|명|분|곳|시간)(가|를|는|와|로)([^가-힣]|$)|\}일(가|를|는|와|으로)([^가-힣]|$)/

async function language(uiLanguage: 'ko' | 'en') {
  await followSettings({ onEvent: () => () => undefined, settingsGet: async () => ({ uiLanguage }) } as unknown as Parameters<typeof followSettings>[0])
}

const base = { defaultEngine: 'claude', autoStart: false, teamSync: 'manual', searchTemplate: '', agentBrowser: '', claudeModel: '', codexModel: '' } as AppSettingsDto
beforeEach(() => {
  vi.clearAllMocks()
  fake.handlers.clear()
  fake.queue = Promise.resolve()
  fake.updates = 0
  fake.load.mockResolvedValue(base)
  fake.save.mockResolvedValue(undefined)
  setBrainChoiceHook(fake.changed)
  registerSettingsIpc()
})

describe('settings strings and interface language', () => {
  it('settings:set accepts system, ko and en and rejects any other uiLanguage', async () => {
    const save = fake.handlers.get('settings:set')!
    for (const uiLanguage of ['system', 'ko', 'en'] as const) {
      vi.clearAllMocks()
      await save(null, { uiLanguage })
      expect(fake.save).toHaveBeenCalledWith(expect.objectContaining({ uiLanguage }))
      expect(fake.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings:changed', settings: expect.objectContaining({ uiLanguage }) }))
    }
    for (const uiLanguage of [null, '', 'KO', 'fr', 1, ['ko'], {}]) {
      vi.clearAllMocks()
      fake.updates = 0
      await expect(save(null, { uiLanguage }), JSON.stringify(uiLanguage)).rejects.toThrow('Invalid interface language')
      expect(fake.updates).toBe(0)
      expect(fake.save).not.toHaveBeenCalled()
      expect(fake.broadcast).not.toHaveBeenCalled()
    }
  })

  it('settings keys keep the English text', () => {
    for (const key of keys) {
      expect(en[key], key).toBe(ENGLISH[key])
      expect(key in ko3 || key in ko4, key).toBe(true)
    }
  })

  it('every settings ko value is Korean, keeps placeholders and uses the right particles', () => {
    for (const key of keys) {
      const value = ko[key]!
      expect(value, key).toMatch(/[\uAC00-\uD7A3]/)
      expect(placeholders(value), key).toEqual(placeholders(en[key]))
      expect(isOffending(value.replace(/\{\w+\}/g, '1')), key).toBe(false)
      expect(value, key).not.toMatch(PLACEHOLDER_PARTICLE)
      expect(value, key).not.toMatch(COUNTER_PARTICLE)
    }
  })

  it('labels built outside components follow the UI language', async () => {
    const states: DesktopControlStatusDto[] = [
      { state: 'running' }, { state: 'running', engineLabel: 'Claude' }, { state: 'ready' }, { state: 'needs-person' },
      { state: 'paused', resumable: true }, { state: 'paused' }, { state: 'idle' },
    ]
    const english = ['The comet is controlling your computer', 'Claude is controlling your computer', 'The comet is about to use your computer', 'Your attention is needed', 'You took over', 'Computer control is off', 'Computer control is off']
    const source = LEARNING_SOURCES.find(one => one.key === 'workMap')!
    try {
      await language('ko')
      expect(states.map(computerStateLabel)).toEqual(['컴퓨터를 제어하는 중: 코멧', '컴퓨터를 제어하는 중: Claude', '곧 컴퓨터를 사용해요: 코멧', ko['settingsUi.attention'], ko['settingsUi.tookOver'], ko['settingsUi.controlOff'], ko['settingsUi.controlOff']])
      expect(t(source.nameKey)).toBe('브라우저 기록, 북마크, 다운로드')
    } finally {
      await language('en')
    }
    expect(states.map(computerStateLabel)).toEqual(english)
    expect(t(source.nameKey)).toBe('Browser history, bookmarks and downloads')
  })
})
