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
vi.mock('../src/main/habits-ipc.js', () => ({ appUse: async () => [{ app: 'kakaotalk', label: '카카오톡' }], setAppUse: fake.setApp, habitDrafts: async () => [{ key: 'h1', title: '메일 분류' }], answerHabit: fake.answer }))
vi.mock('../src/main/team.js', () => ({ connectGithub: fake.connect, disconnectGithub: fake.disconnect, hasBackup: async () => fake.remote, performSync: fake.sync, startAutoSync: fake.autoSync }))
vi.mock('../src/main/work-map-job.js', () => ({ deskSettingChanged: fake.desk, refreshWorkMap: fake.refresh, workMapSettingChanged: fake.workMap }))
vi.mock('../src/main/approvals.js', () => ({ reviewRuleInput: (value: { kind: string; target: string }) => ({ ...value, operation: 'submit' }) }))
import { preferenceHost } from '../src/main/preferences-chat.js'

const rules = { reviewRules: vi.fn(async () => [{ kind: 'ask-first' as const, operation: 'submit', target: 'naver.com' }]), addReviewRule: vi.fn(), removeReviewRule: vi.fn() }
const ctx = { git: {}, paths: { cache: '/fake/vault/.engram' } } as never
const chat = () => preferences(preferenceHost(ctx, rules))

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env['ENGRAM_USERDATA']
  fake.settings = { autoStart: true, workMap: true, workFiles: true, workApps: true, teamSync: 'auto', theme: 'system', appsOff: [] }
})

it('each sentence does what its Settings row did, and tells every open window', async () => {
  const c = chat()
  expect(await c.say('b', '컴퓨터 켜면 자동으로 실행 꺼줘')).toBe('컴퓨터를 켜도 자동으로 실행하지 않을게요.')
  expect(fake.settings['autoStart']).toBe(false)
  expect(fake.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false })
  expect(fake.broadcast).toHaveBeenCalledWith({ type: 'settings:changed', settings: fake.settings })

  await c.say('b', '내 앱 활동 기억하지 마')
  expect(fake.activity).toHaveBeenCalledWith(false)
  await c.say('b', '방문 기록은 참고하지 마')
  expect(fake.settings['workMap']).toBe(false)
  expect(fake.workMap).toHaveBeenCalledWith(false)
  await c.say('b', '최근 파일은 참고하지 마')
  expect(fake.settings).toMatchObject({ workFiles: false, workApps: true })
  expect(fake.desk).not.toHaveBeenCalled()

  await c.say('b', '카카오톡은 건드리지 마')
  expect(fake.setApp).toHaveBeenCalledWith('kakaotalk', '카카오톡', false)
  await c.say('b', '메일 분류 습관은 잊어')
  expect(fake.answer).toHaveBeenCalledWith(ctx, 'h1', false)
  await c.say('b', 'daum.net에서는 항상 먼저 물어봐')
  expect(rules.addReviewRule).toHaveBeenCalledWith({ kind: 'ask-first', target: 'daum.net', operation: 'submit' })
  expect(await c.say('b', '항상 물어보는 곳 뭐 있어?')).toBe('항상 먼저 여쭤보는 곳: naver.com')

  await c.say('b', '다크 모드로 바꿔')
  expect(fake.nativeTheme.themeSource).toBe('dark')
  await c.say('b', '자동 백업 꺼줘')
  expect(fake.settings['teamSync']).toBe('manual')
  await c.say('b', '깃허브에 백업해줘')
  expect(fake.sync).toHaveBeenCalledOnce()
  await c.say('b', '깃허브 백업 해제해줘')
  expect(fake.disconnect).toHaveBeenCalledOnce()
  await c.say('b', '컴퓨터 제어 꺼줘')
  expect(fake.stop).toHaveBeenCalledOnce()
})

it('exports logs without a folder picker, and away from the real Downloads when the app\'s data has been moved', async () => {
  expect(await chat().say('b', '로그 내보내줘')).toBe('로그를 다운로드 폴더에 내보냈어요. engram-logs-7')
  expect(fake.logs).toHaveBeenLastCalledWith(ctx, '/fake/downloads')
  process.env['ENGRAM_USERDATA'] = '/fake/moved'
  await chat().say('b', '로그 내보내줘')
  expect(fake.logs).toHaveBeenLastCalledWith(ctx, '/fake/userData/exports')
  expect(fake.dialog).not.toHaveBeenCalled()
})

it('widening waits for a yes: a rule is not removed, a repository not connected, a source not turned on before it', async () => {
  const c = chat()
  await c.say('b', 'naver.com에서는 이제 묻지 마')
  await c.say('b', '아니')
  expect(rules.removeReviewRule).not.toHaveBeenCalled()
  expect(await c.say('b', '깃허브 백업 https://github.com/me/notes 로 연결해줘')).toMatch(/연결할까요\?/)
  expect(fake.connect).not.toHaveBeenCalled()
  expect(await c.say('b', '응')).toBe('깃허브 백업을 연결했어요.')
  expect(fake.connect).toHaveBeenCalledWith(ctx, 'https://github.com/me/notes')
  fake.settings['workMap'] = false
  await c.say('b', '방문 기록 다시 참고해')
  expect(fake.settings['workMap']).toBe(false)
  await c.say('b', '네')
  expect(fake.settings['workMap']).toBe(true)
  expect(fake.workMap).toHaveBeenLastCalledWith(true)
  // No native box anywhere on this path.
  expect(fake.dialog).not.toHaveBeenCalled()
})

it('says so in one Korean line when a connection fails', async () => {
  fake.connect.mockRejectedValueOnce(new Error('already-connected'))
  const c = chat()
  await c.say('b', '깃허브 백업 https://github.com/me/other 로 연결해줘')
  expect(await c.say('b', '응')).toBe('깃허브에 연결하지 못했어요. 저장소 주소와 로그인을 확인해 주세요.')
})
