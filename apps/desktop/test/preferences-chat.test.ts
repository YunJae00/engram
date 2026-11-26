import { beforeEach, expect, it, vi } from 'vitest'
import { preferences } from 'core'

const fake = vi.hoisted(() => ({
  settings: { autoStart: true, workMap: true, workFiles: true, workApps: true, teamSync: 'auto', theme: 'system', appsOff: [] } as Record<string, unknown>,
  app: { isPackaged: true, setLoginItemSettings: vi.fn(), getPath: (name: string) => `/fake/${name}` },
  nativeTheme: { themeSource: 'system' }, broadcast: vi.fn(), activity: vi.fn(), workMap: vi.fn(), desk: vi.fn(), refresh: vi.fn(async () => null),
  logs: vi.fn(async (_ctx: unknown, into: string) => `${into}/engram-logs-7`), stop: vi.fn(), dialog: vi.fn(),
  connect: vi.fn(async () => ({ ok: true })), disconnect: vi.fn(), sync: vi.fn(), remote: true, autoSync: vi.fn(),
  setApp: vi.fn(), answer: vi.fn(),
}))
vi.mock('electron', () => ({ app: fake.app, nativeTheme: fake.nativeTheme, dialog: { showOpenDialog: fake.dialog, showMessageBox: fake.dialog } }))
vi.mock('../src/main/settings.js', () => ({ updateSettings: async (change: (held: Record<string, unknown>) => Record<string, unknown>) => (fake.settings = change(fake.settings)) }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: fake.broadcast }))
vi.mock('../src/main/activity-watch.js', () => ({ setActivityWatchEnabled: fake.activity }))
vi.mock('../src/main/config-ipc.js', () => ({ writeLogs: fake.logs }))
vi.mock('../src/main/desktop-control.js', () => ({ stopDesktopControl: fake.stop }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('../src/main/habits-ipc.js', () => ({ appUse: async () => [{ app: 'kakaotalk', label: '카카오톡', on: true }], setAppUse: fake.setApp, habitDrafts: async () => [{ key: 'h1', title: '메일 분류' }], answerHabit: fake.answer }))
vi.mock('../src/main/team.js', () => ({ connectGithub: fake.connect, disconnectGithub: fake.disconnect, hasBackup: async () => fake.remote, performSync: fake.sync, startAutoSync: fake.autoSync }))
vi.mock('../src/main/work-map-job.js', () => ({ deskSettingChanged: fake.desk, refreshWorkMap: fake.refresh, workMapSettingChanged: fake.workMap }))
vi.mock('../src/main/approvals.js', () => ({ reviewRuleInput: (value: { kind: string; target: string }) => ({ ...value, operation: 'submit' }) }))
import { preferenceHost } from '../src/main/preferences-chat.js'

const rules = { reviewRules: vi.fn(async () => [{ kind: 'ask-first' as const, operation: 'submit', target: 'naver.com' }]), addReviewRule: vi.fn(), removeReviewRule: vi.fn() }
const ctx = { git: {}, paths: { cache: '/fake/vault/.engram' } } as never
const chat = () => {
  const tool = preferences(preferenceHost(ctx, rules)).tool('b', () => said)
  let said = ''
  return (person: string, args: Record<string, unknown>) => { said = person; return tool.run(args, { task: person }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env['ENGRAM_USERDATA']
  fake.settings = { autoStart: true, workMap: true, workFiles: true, workApps: true, teamSync: 'auto', theme: 'system', appsOff: [] }
})

it('each call the model makes does what its Settings row did, and tells every open window', async () => {
  const call = chat()
  expect(await call('켤 때 엔그램은 안 떠도 돼', { do: 'auto_start', on: false })).toBe('컴퓨터를 켜도 자동으로 실행하지 않을게요.')
  expect(fake.settings['autoStart']).toBe(false)
  expect(fake.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false })
  expect(fake.broadcast).toHaveBeenCalledWith({ type: 'settings:changed', settings: fake.settings })

  await call('내가 쓰는 프로그램은 신경 끄고', { do: 'app_activity', on: false })
  expect(fake.activity).toHaveBeenCalledWith(false)
  await call('들른 사이트도 보지 말고', { do: 'learn_places', on: false })
  expect(fake.settings['workMap']).toBe(false)
  expect(fake.workMap).toHaveBeenCalledWith(false)
  await call('요즘 연 파일도 빼줘', { do: 'learn_files', on: false })
  expect(fake.settings).toMatchObject({ workFiles: false, workApps: true })
  expect(fake.desk).not.toHaveBeenCalled()

  await call('카톡은 만지지 마', { do: 'app', name: '카카오톡', on: false })
  expect(fake.setApp).toHaveBeenCalledWith('kakaotalk', '카카오톡', false)
  await call('메일 분류 그거 내 방식 아니야', { do: 'habit', name: '메일 분류', on: false })
  expect(fake.answer).toHaveBeenCalledWith(ctx, 'h1', false)
  await call('daum.net은 내기 전에 꼭 확인받아', { do: 'ask_first', name: 'daum.net', on: true })
  expect(rules.addReviewRule).toHaveBeenCalledWith({ kind: 'ask-first', target: 'daum.net', operation: 'submit' })
  expect(await call('확인받기로 한 데 어디야?', { do: 'review_rules' })).toBe('항상 먼저 여쭤보는 곳: naver.com')

  await call('화면 어둡게', { do: 'theme', name: 'dark' })
  expect(fake.nativeTheme.themeSource).toBe('dark')
  await call('백업 알아서 하는 건 꺼', { do: 'backup_auto', on: false })
  expect(fake.settings['teamSync']).toBe('manual')
  await call('지금 백업 한 번', { do: 'backup_now' })
  expect(fake.sync).toHaveBeenCalledOnce()
  await call('깃허브 연결 풀어', { do: 'backup_disconnect' })
  expect(fake.disconnect).toHaveBeenCalledOnce()
  await call('화면 조작 그만', { do: 'computer_control', on: false })
  expect(fake.stop).toHaveBeenCalledOnce()
})

it('exports logs without a folder picker, and away from the real Downloads when the app\'s data has been moved', async () => {
  expect(await chat()('로그 좀 모아줘', { do: 'export_logs' })).toBe('로그를 다운로드 폴더에 내보냈어요. engram-logs-7')
  expect(fake.logs).toHaveBeenLastCalledWith(ctx, '/fake/downloads')
  process.env['ENGRAM_USERDATA'] = '/fake/moved'
  await chat()('로그 좀 모아줘', { do: 'export_logs' })
  expect(fake.logs).toHaveBeenLastCalledWith(ctx, '/fake/userData/exports')
  expect(fake.dialog).not.toHaveBeenCalled()
})

it('widening waits for the person\'s yes: a rule is not removed, a source not turned on before it, and a repository is never connected from chat', async () => {
  const call = chat()
  const loosen = { do: 'ask_first', name: 'naver.com', on: false }
  await call('naver.com은 이제 그냥 해', loosen)
  await call('아뇨', loosen)
  expect(rules.removeReviewRule).not.toHaveBeenCalled()
  expect(await call('https://github.com/me/notes 에 노트 올려줘', { do: 'backup_connect', name: 'https://github.com/me/notes' })).toBe('그건 채팅으로는 바꿀 수 없어요.')
  expect(fake.connect).not.toHaveBeenCalled()
  fake.settings['workMap'] = false
  const places = { do: 'learn_places', on: true }
  await call('들른 사이트 다시 봐도 돼', places)
  expect(fake.settings['workMap']).toBe(false)
  await call('네', places)
  expect(fake.settings['workMap']).toBe(true)
  expect(fake.workMap).toHaveBeenLastCalledWith(true)
  expect(fake.dialog).not.toHaveBeenCalled()
})

it('the chat handler has no settings reply of its own: every sentence reaches the model, which has the settings tool on its menu', async () => {
  const { readFile } = await import('node:fs/promises')
  const ipc = await readFile('apps/desktop/src/main/ipc.ts', 'utf8')
  const handler = ipc.slice(ipc.indexOf('async function handleChatSend('))
  expect(ipc).not.toMatch(/settingsChat\.(say|opening)\(/)
  expect(handler).not.toContain('isPersonSentence(')
  expect(ipc).toContain("settingsChat.tool(channel, () => turnGoals.get(channel) ?? '')")
})
