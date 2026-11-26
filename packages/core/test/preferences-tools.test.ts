import { describe, expect, it } from 'vitest'
import { activityLine, preferences, PREFERENCE_ACTIONS, widens, type PreferenceAsk, type PreferenceHost } from '../src/preferences-tools.js'

function fakeHost(over: Partial<PreferenceHost> = {}) {
  const calls: string[] = []
  const state = { connected: false, rules: [] as { kind: 'ask-first' | 'allow'; target: string }[] }
  const host: PreferenceHost = {
    autoStart: async on => { calls.push(`autoStart:${on}`) },
    learning: async (source, on) => { calls.push(`learning:${source}:${on}`) },
    rescanWork: async () => { calls.push('rescan') },
    apps: async () => [{ app: 'kakaotalk', label: '카카오톡', on: true }, { app: 'excel', label: '엑셀', on: false }],
    setApp: async (app, label, on) => { calls.push(`app:${app}:${label}:${on}`) },
    habits: async () => [{ key: 'h1', title: '주간 보고서 정리' }, { key: 'h2', title: '메일 분류' }],
    answerHabit: async (key, keep) => { calls.push(`habit:${key}:${keep}`) },
    reviewRules: async () => state.rules,
    setReviewRule: async (kind, site, on) => { calls.push(`rule:${kind}:${site}:${on}`) },
    audit: async () => [],
    exportLogs: async () => { calls.push('export'); return 'engram-logs-1' },
    backup: {
      available: () => true,
      connected: async () => state.connected,
      connect: async url => { calls.push(`connect:${url}`); state.connected = true; return { ok: true } },
      disconnect: async () => { calls.push('disconnect'); state.connected = false },
      now: async () => { calls.push('backup-now') },
      auto: async on => { calls.push(`auto:${on}`) },
    },
    stopComputerControl: () => { calls.push('stop-control') },
    theme: async theme => { calls.push(`theme:${theme}`) },
    ...over,
  }
  return { host, calls, state }
}

const NOW = new Date(2026, 10, 16, 15, 0, 0)
const setup = (over: Partial<PreferenceHost> = {}) => {
  const fake = fakeHost(over), chat = preferences(fake.host, () => NOW)
  let said = ''
  const tool = chat.tool('c', () => said)
  const call = (person: string, args: Record<string, unknown>) => { said = person; return tool.run(args, { task: person }) }
  return { ...fake, chat, call }
}
const HANGUL_ONLY = /^[^A-Za-z]*$/

describe('the model\'s call changes a setting, and the tool says what changed in one plain Korean line', () => {
  const cases: [string, Record<string, unknown>, string, string[]][] = [
    ['로그인할 때 엔그램 뜨는 거 이제 안 해도 돼', { do: 'auto_start', on: false }, '컴퓨터를 켜도 자동으로 실행하지 않을게요.', ['autoStart:false']],
    ['맥 켜자마자 엔그램도 같이 열어줘', { do: 'auto_start', on: true }, '컴퓨터를 켜면 자동으로 실행할게요.', ['autoStart:true']],
    ['내가 무슨 프로그램 쓰는지는 보지 말아줘', { do: 'app_activity', on: false }, '앱 활동은 이제 참고하지 않을게요.', ['learning:activity:false']],
    ['요즘 연 문서들은 신경 쓰지 마', { do: 'learn_files', on: false }, '최근 파일은 이제 참고하지 않을게요.', ['learning:files:false']],
    ['인터넷 들른 곳은 이제 빼줘', { do: 'learn_places', on: false }, '자주 가는 사이트는 이제 참고하지 않을게요.', ['learning:places:false']],
    ['내가 일하는 폴더 한 번 더 둘러봐 줄래', { do: 'rescan_work' }, '작업하시는 곳을 다시 살펴볼게요.', ['rescan']],
    ['카톡엔 손대지 말아줘', { do: 'app', name: '카카오톡', on: false }, '카카오톡은 이제 쓰지 않을게요.', ['app:kakaotalk:카카오톡:false']],
    ['슬랙은 열지 말아줘', { do: 'app', name: '슬랙', on: false }, '슬랙은 이제 쓰지 않을게요.', ['app:슬랙:슬랙:false']],
    ['내가 일하는 버릇 눈치챈 거 있어?', { do: 'habits' }, '알아챈 업무 습관은 2가지예요.\n- 주간 보고서 정리\n- 메일 분류', []],
    ['메일 분류하는 거 그건 내 방식 아니야', { do: 'habit', name: '메일 분류', on: false }, '"메일 분류"는 잊었어요.', ['habit:h2:false']],
    ['주간 보고서 그렇게 하는 거 맞아', { do: 'habit', name: '주간 보고서', on: true }, '"주간 보고서 정리" 방식을 기억해 둘게요.', ['habit:h1:true']],
    ['어디든 보내기 전엔 나한테 꼭 확인해', { do: 'ask_first', on: true }, '보내거나 제출하기 전에는 항상 먼저 여쭤볼게요.', []],
    ['naver.com은 제출 전에 늘 나한테 물어봐', { do: 'ask_first', name: 'naver.com', on: true }, 'naver.com에서는 제출하기 전에 항상 먼저 여쭤볼게요.', ['rule:ask-first:naver.com:true']],
    ['먼저 묻기로 한 사이트 어디어디야?', { do: 'review_rules' }, '따로 정해 둔 곳은 없어요. 보내거나 제출하기 전에는 늘 먼저 여쭤봐요.', []],
    ['오늘 다들 뭐 했는지 기록 좀', { do: 'activity_log' }, '오늘은 아직 한 일이 없어요.', []],
    ['로그 파일 하나 뽑아줘', { do: 'export_logs' }, '로그를 다운로드 폴더에 내보냈어요. engram-logs-1', ['export']],
    ['깃허브 백업 끊어줘', { do: 'backup_disconnect' }, '아직 깃허브 백업이 연결되어 있지 않아요.', []],
    ['화면 조작하는 거 그만해', { do: 'computer_control', on: false }, '컴퓨터 제어를 멈췄어요.', ['stop-control']],
    ['앱 직접 만져도 돼', { do: 'computer_control', on: true }, '앱을 직접 다뤄야 할 때 그때 한 번 여쭤볼게요.', []],
    ['눈 아프니까 화면 까맣게 해줘', { do: 'theme', name: 'dark' }, '어두운 화면으로 바꿨어요.', ['theme:dark']],
  ]
  for (const [person, args, reply, did] of cases) {
    it(person, async () => {
      const { call, calls } = setup()
      const said = await call(person, args)
      expect(said).toBe(reply)
      expect(calls).toEqual(did)
      expect(said.replace(/naver\.com|engram-logs-1/g, '')).toMatch(HANGUL_ONLY)
    })
  }

  it('backs up and disconnects once a repository is connected', async () => {
    const { call, calls, state } = setup()
    state.connected = true
    expect(await call('지금 바로 백업 한 번 돌려줘', { do: 'backup_now' })).toBe('깃허브에 백업했어요.')
    expect(await call('백업 자동으로 하는 건 꺼둬', { do: 'backup_auto', on: false })).toBe('자동 백업을 껐어요.')
    expect(await call('깃허브랑 연결 풀어줘', { do: 'backup_disconnect' })).toBe('깃허브 백업 연결을 해제했어요. 이미 올라간 내용은 그대로 있어요.')
    expect(calls).toEqual(['backup-now', 'auto:false', 'disconnect'])
  })

  it('says so where this copy keeps no history to back up', async () => {
    const { call, calls, host } = setup()
    host.backup.available = () => false
    expect(await call('https://github.com/me/notes 에 백업 붙여줘', { do: 'backup_connect', name: 'https://github.com/me/notes' })).toBe('이 컴퓨터에서는 백업을 쓸 수 없어요.')
    expect(calls).toEqual([])
  })

  it('tells a day from the audit files by the person\'s own midnight', async () => {
    const asked: string[] = []
    const at = (hour: number) => new Date(2026, 10, 16, hour).toISOString()
    const { call } = setup({ audit: async day => { asked.push(day); return ([
      { at: at(1), kind: 'step', channel: 'bot-a', bot: '지민', tool: 'open_page', url: 'https://finance.naver.com/item' },
      { at: at(2), kind: 'step', channel: 'bot-a', bot: '지민' },
      { at: at(3), kind: 'step', channel: 'bot-b', bot: '서연' },
      { at: at(4), kind: 'approval', channel: 'bot-a', bot: '지민', detail: 'send' },
      { at: new Date(2026, 10, 15, 23).toISOString(), kind: 'step', channel: 'bot-b', bot: '서연' },
    ] as const).filter(entry => entry.at.startsWith(day)) } })
    expect(await call('팀이 오늘 한 일 기록 보여줘', { do: 'activity_log' })).toBe('오늘은 지민 2번, 서연 1번 일했어요.\n다녀온 곳: [finance.naver.com](https://finance.naver.com)\n먼저 여쭤본 일은 1번이에요.')
    expect(asked.length).toBeGreaterThanOrEqual(1)
    expect(await call('어제 기록은?', { do: 'activity_log', name: 'yesterday' })).toBe('어제는 서연 1번 일했어요.')
    expect(activityLine([], '어제')).toBe('어제는 아직 한 일이 없어요.')
  })

  it('a change that fails says so in one line and changes nothing else', async () => {
    const { call } = setup({ autoStart: async () => { throw new Error('EPERM: operation not permitted') } })
    expect(await call('부팅할 때 자동 실행 빼줘', { do: 'auto_start', on: false })).toBe('바꾸지 못했어요. 잠시 후 다시 말씀해 주세요.')
  })

  it('an action off the list changes nothing', async () => {
    const { call, calls } = setup()
    expect(await call('디스크 싹 밀어줘', { do: 'format_disk' })).toBe('그건 여기서 바꿀 수 없어요.')
    expect(calls).toEqual([])
  })

  it('the reply is Korean-closing only in a Korean conversation', () => {
    const { chat } = setup()
    expect((chat.tool('c', () => '다크로 바꿔줘').closes as (args: Record<string, unknown>) => boolean)({})).toBe(true)
    expect((chat.tool('c', () => 'switch to dark').closes as (args: Record<string, unknown>) => boolean)({})).toBe(false)
  })
})

describe('narrowing is done at once, widening waits for the person\'s own yes', () => {
  const widening: [string, Record<string, unknown>, string, string, string][] = [
    ['앱 쓰는 거 다시 봐도 돼', { do: 'app_activity', on: true }, '앱 활동을 다시 참고할까요?', '앱 활동을 다시 참고할게요.', 'learning:activity:true'],
    ['요즘 연 파일 다시 참고해도 괜찮아', { do: 'learn_files', on: true }, '최근 파일을 다시 참고할까요?', '최근 파일을 다시 참고할게요.', 'learning:files:true'],
    ['엑셀 이제 열어도 돼', { do: 'app', name: '엑셀', on: true }, '엑셀을 다시 써도 될까요?', '엑셀을 다시 쓸게요.', 'app:excel:엑셀:true'],
    ['naver.com은 이제 안 물어봐도 돼', { do: 'ask_first', name: 'naver.com', on: false }, 'naver.com에서 먼저 여쭤보는 규칙을 없앨까요?', 'naver.com에서 먼저 여쭤보는 규칙을 없앴어요.', 'rule:ask-first:naver.com:false'],
  ]
  for (const [person, args, asks, done, did] of widening) {
    it(`${person}: nothing changes until the person says yes in a later message`, async () => {
      const { call, calls } = setup()
      expect(await call(person, args)).toBe(asks)
      expect(await call(person, args)).toBe(asks)
      expect(calls).toEqual([])
      expect(await call('좋아요', args)).toBe(done)
      expect(calls).toEqual([did])
      expect(await call('좋아요', args)).toBe(asks)
      expect(calls).toEqual([did])
    })
    it(`${person}: a no leaves it as it is`, async () => {
      const { call, calls } = setup()
      await call(person, args)
      expect(await call('아뇨', args)).toBe('그대로 둘게요.')
      expect(await call('네', args)).toBe(asks)
      expect(calls).toEqual([])
    })
  }

  it('an app that is already in reach needs no question', async () => {
    const { call, calls } = setup()
    expect(await call('카톡 써도 돼', { do: 'app', name: '카카오톡', on: true })).toBe('카카오톡은 지금도 쓸 수 있어요.')
    expect(await call('파워포인트 써도 돼', { do: 'app', name: '파워포인트', on: true })).toBe('파워포인트는 지금도 쓸 수 있어요.')
    expect(calls).toEqual([])
  })

  it('says which changes widen', () => {
    const on = (name: PreferenceAsk['do'], value: boolean): PreferenceAsk => ({ do: name, on: value, name: 'x.com' })
    const wide = PREFERENCE_ACTIONS.flatMap(name => [true, false].filter(value => widens(on(name, value))).map(value => `${name}:${value}`))
    expect(wide).toEqual(['app_activity:true', 'learn_places:true', 'learn_files:true', 'learn_apps:true', 'app:true', 'ask_first:false', 'auto_allow:true', 'backup_connect:true', 'backup_connect:false'])
  })

  it('a yes in another conversation, a late yes, a yes to a different change, or leaving `on` out confirm nothing', async () => {
    let now = NOW.getTime(), said = ''
    const fake = fakeHost(), chat = preferences(fake.host, () => new Date(now))
    const one = chat.tool('one', () => said), two = chat.tool('two', () => said)
    const excel = { do: 'app', name: '엑셀', on: true }
    said = '엑셀 써도 돼'; await one.run(excel, { task: '' })
    said = '응'; expect(await two.run(excel, { task: '' })).toBe('엑셀을 다시 써도 될까요?')
    said = '엑셀 써도 돼'; await one.run(excel, { task: '' })
    said = '응'; expect(await one.run({ do: 'learn_files', on: true }, { task: '' })).toBe('최근 파일을 다시 참고할까요?')
    said = '엑셀 써도 돼'; await one.run(excel, { task: '' })
    now += 11 * 60_000
    said = '응'; expect(await one.run(excel, { task: '' })).toBe('엑셀을 다시 써도 될까요?')
    expect(await one.run({ do: 'app_activity' }, { task: '' })).toBe('앱 활동은 이제 참고하지 않을게요.')
    expect(fake.calls).toEqual(['learning:activity:false'])
  })

  it('a standing allow and a backup connect are made only after the person types a yes in a later message', async () => {
    const { call, calls } = setup()
    const allow = { do: 'auto_allow', name: 'https://forms.sample.org/apply', on: true }
    expect(await call('forms.sample.org 신청서는 묻지 말고 바로 넣어', allow)).toBe('forms.sample.org에서는 묻지 않고 바로 제출해도 될까요?')
    expect(await call('forms.sample.org 신청서는 묻지 말고 바로 넣어', allow)).toBe('forms.sample.org에서는 묻지 않고 바로 제출해도 될까요?')
    expect(calls).toEqual([])
    expect(await call('넵', { ...allow, name: 'forms.sample.org' })).toBe('forms.sample.org에서는 묻지 않고 제출할게요.')
    const backup = { do: 'backup_connect', name: 'https://github.com/haneul/diary' }
    expect(await call('내 메모들 github.com/haneul/diary 로 올려두게 해줘', backup)).toBe('https://github.com/haneul/diary에 백업을 연결할까요? 노트가 그 저장소로 올라가요.')
    expect(await call('아니요', backup)).toBe('그대로 둘게요.')
    expect(await call('다시 생각해보니 github.com/haneul/diary 연결해줘', backup)).toBe('https://github.com/haneul/diary에 백업을 연결할까요? 노트가 그 저장소로 올라가요.')
    expect(await call('좋아요', backup)).toBe('깃허브 백업을 연결했어요.')
    expect(calls).toEqual(['rule:allow:forms.sample.org:true', 'connect:https://github.com/haneul/diary'])
  })
})
