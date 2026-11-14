import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineCwd } from 'core'

const fixture = vi.hoisted(() => ({ root: '', query: vi.fn(), binary: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>()
  // Onboarding's step counter is its only useState(1); start it on step 2.
  return { ...actual, useState: (value: unknown) => actual.useState(value === 1 ? 2 : value) }
})
vi.mock('../src/main/brain-connections.js', () => ({ loadBrainConnections: async () => ({}), hasBrainConnection: () => false, probeConnection: vi.fn(), clearBrainConnection: vi.fn(), connectionEnvironment: () => ({}) }))
vi.mock('../src/main/claude-runtime.js', () => ({ afterFirstClaudeSession: async () => undefined, claudeSessionStarted: () => {}, installedClaudeBinary: fixture.binary, loadClaudeSdk: async () => ({ query: fixture.query }) }))
vi.mock('../src/main/engine-cloud.js', async original => ({
  ...await original<typeof import('../src/main/engine-cloud.js')>(),
  claudeBinary: fixture.binary,
  withHelpersOnPath: () => ({ PATH: 'fixture-runtime-path' }),
}))
vi.mock('../src/renderer/src/api.js', () => {
  const never = () => new Promise(() => undefined)
  const api = new Proxy({}, { get: (_target, key) => key === 'onEvent' ? () => () => undefined : never })
  return { api, apiErrorText: (message: string) => message }
})
vi.mock('../src/renderer/src/state-slices.js', () => ({
  useShellState: () => ({ engines: [], enginesDetected: true, pendingWork: { inbox: 0, notes: 0 } }),
  useTopBarState: () => ({ activity: 'list', errandWall: null, answerErrandWall: vi.fn(), showToast: vi.fn(), vaultReady: true }),
}))
vi.mock('../src/renderer/src/lib/accountProfiles.js', () => ({ useAccountProfiles: () => null }))
vi.mock('../src/renderer/src/lib/accountUsage.js', () => ({ useAccountUsage: () => [], useAccountUsageChecking: () => false, refreshAccountUsage: async () => undefined }))
vi.mock('../src/renderer/src/components/BotAvatar.js', () => ({ BotAvatar: () => null, useAvatarTheme: () => 'light' }))

import { chosenModel, ClaudeEngine } from '../src/main/engine-claude.js'
import { loadSettings } from '../src/main/settings.js'
import { ModelPicker } from '../src/renderer/src/components/ModelPicker.js'
import { TopBar } from '../src/renderer/src/components/TopBar.js'
import { Onboarding } from '../src/renderer/src/views/Onboarding.js'

const PICKERS = /model-picker|provider-pick|effort|onboard-choice|onboard-choose-|onboard-model|ChatGPT/
const WORKDIR = 'C:/tmp' as EngineCwd

beforeEach(() => {
  vi.clearAllMocks()
  fixture.binary.mockReturnValue('fixture-claude')
  fixture.query.mockImplementation(async function* () { yield { type: 'result', subtype: 'success', result: 'fixture answer' } })
})
afterEach(() => { vi.unstubAllEnvs() })

describe('one engine, no knobs', () => {
  it('works on claude-opus-5-5 and runs chores on haiku', () => {
    vi.stubEnv('ENGRAM_CLAUDE_MODEL', '')
    expect(chosenModel()).toBe('claude-opus-5-5')
    expect(chosenModel('fast')).toBe('haiku')
  })

  it('lets only ENGRAM_CLAUDE_MODEL override the model', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.example')
    vi.stubEnv('ANTHROPIC_MODEL', 'gateway-model')
    vi.stubEnv('ENGRAM_CLAUDE_MODEL', '')
    expect(chosenModel()).toBe('claude-opus-5-5')
    vi.stubEnv('ENGRAM_CLAUDE_MODEL', 'fixture-model')
    expect(chosenModel()).toBe('fixture-model')
    expect(chosenModel('fast')).toBe('fixture-model')
  })

  it('ignores a stored or per-conversation model on a real run', async () => {
    vi.stubEnv('ENGRAM_CLAUDE_MODEL', '')
    await mkdir(resolve('tmp'), { recursive: true })
    fixture.root = await mkdtemp(resolve('tmp/one-engine-run-'))
    await writeFile(resolve(fixture.root, 'settings.json'), JSON.stringify({ claudeModel: 'sonnet' }))
    const engine = new ClaudeEngine()
    for await (const event of engine.run({ prompt: 'Hi', workdir: WORKDIR, model: 'sonnet' })) void event
    expect(fixture.query.mock.lastCall![0].options.model).toBe('claude-opus-5-5')
    for await (const event of engine.run({ prompt: 'Hi', workdir: WORKDIR, modelHint: 'fast', model: 'opus' })) void event
    expect(fixture.query.mock.lastCall![0].options.model).toBe('haiku')
  })

  it('loads an old Codex choice as Claude and drops stored effort', async () => {
    await mkdir(resolve('tmp'), { recursive: true })
    fixture.root = await mkdtemp(resolve('tmp/one-engine-settings-'))
    await writeFile(resolve(fixture.root, 'settings.json'), JSON.stringify({
      defaultEngine: 'codex', claudeModel: 'sonnet', claudeEffort: 'low', codexEffort: 'high',
      aiSelections: { filing: { engine: 'codex', model: 'gpt', effort: 'high' } },
    }))
    const loaded = await loadSettings()
    expect(loaded.defaultEngine).toBe('claude')
    expect(loaded.aiSelections['filing']?.engine).toBe('claude')
    expect(loaded.aiSelections['filing']).not.toHaveProperty('effort')
    expect(loaded).not.toHaveProperty('claudeEffort')
    expect(loaded).not.toHaveProperty('codexEffort')
    expect(loaded.claudeModel).toBe('sonnet')
  })

  it('renders no engine, model or effort picker in chat, the top bar or onboarding', () => {
    expect(renderToStaticMarkup(createElement(ModelPicker, { scope: 'cosmos' }))).toBe('')
    expect(renderToStaticMarkup(createElement(ModelPicker, {}))).toBe('')
    const bar = renderToStaticMarkup(createElement(TopBar, { sidebarOpen: true, developer: false, onToggleSidebar: vi.fn(), splitLayout: 1, onSplit: vi.fn(), onMode: vi.fn() }))
    expect(bar).toContain('connect-banner')
    expect(bar).toContain('Claude')
    expect(bar).not.toMatch(PICKERS)
    const onboarding = renderToStaticMarkup(createElement(Onboarding))
    expect(onboarding).toContain('onboard-step-2')
    expect(onboarding).toContain('Claude')
    expect(onboarding).not.toMatch(PICKERS)
  })

  it('keeps the developer task session picker', () => {
    const html = renderToStaticMarkup(createElement(ModelPicker, { controlled: { value: { engine: 'claude', model: '' }, onChange: vi.fn() } }))
    expect(html).toContain('data-testid="model-picker"')
  })
})

describe('usage limit in a conversation', () => {
  it('never hands the turn to another engine and tells the person when it can resume', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(resolve(__dirname, '../src/main/ipc.ts'), 'utf8')
    expect(source).not.toMatch(/switch: \$\{brainName/)
    expect(source).not.toMatch(/switchTo = /)
    expect(source).not.toMatch(/chatEngine\(channel, ctx\.engines, request\.engineId\)/)
    expect(source).toMatch(/usageLimitMessage\(/)
    expect(source).toMatch(/message: quota \? usageLimitMessage\(/)
    expect(source).toMatch(/if \(turn\?\.verification && kind !== 'quota'\) throw err/)
    expect(source.indexOf("if (isLimited('claude', channel)) {")).toBeGreaterThan(source.indexOf('recordedRequests.add(request)'))
    expect(source).toMatch(/if \(kind === 'quota'\) \{/)
    const pre = source.slice(source.indexOf("if (isLimited('claude', channel)) {"), source.indexOf("if (isLimited('claude', channel)) {") + 500)
    expect(pre).toMatch(/appendBotTurn\(paths, bot\.id, \{ role: 'assistant', text: said/)
    expect(pre).toMatch(/turnOutcomes\.set\(channel, \{ answer: said, asked: true/)
  })
})
