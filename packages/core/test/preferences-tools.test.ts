import { describe, expect, it } from 'vitest'
import { activityLine, preferenceAsk, preferences, PREFERENCE_ACTIONS, widens, type PreferenceAsk, type PreferenceHost } from '../src/preferences-tools.js'

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
const setup = (over: Partial<PreferenceHost> = {}) => { const fake = fakeHost(over); return { ...fake, chat: preferences(fake.host, () => NOW) } }
const HANGUL_ONLY = /^[^A-Za-z]*$/

describe('each removed setting is one plain Korean sentence', () => {
  const cases: [string, string, string[]][] = [
    ['컴퓨터 켜면 자동으로 실행 꺼줘', '컴퓨터를 켜도 자동으로 실행하지 않을게요.', ['autoStart:false']],
    ['컴퓨터 켜면 자동으로 실행해', '컴퓨터를 켜면 자동으로 실행할게요.', ['autoStart:true']],
    ['내 앱 활동 기억하지 마', '앱 활동은 이제 참고하지 않을게요.', ['learning:activity:false']],
    ['내 앱 사용 기록은 보지 마', '앱 활동은 이제 참고하지 않을게요.', ['learning:activity:false']],
    ['최근 파일은 참고하지 마', '최근 파일은 이제 참고하지 않을게요.', ['learning:files:false']],
    ['방문 기록은 참고하지 마', '자주 가는 사이트는 이제 참고하지 않을게요.', ['learning:places:false']],
    ['내 작업 폴더 다시 살펴봐', '작업하시는 곳을 다시 살펴볼게요.', ['rescan']],
    ['카카오톡은 건드리지 마', '카카오톡은 이제 쓰지 않을게요.', ['app:kakaotalk:카카오톡:false']],
    ['슬랙 앱은 쓰지 마', '슬랙은 이제 쓰지 않을게요.', ['app:슬랙:슬랙:false']],
    ['내 업무 습관 뭐 알고 있어?', '알아챈 업무 습관은 2가지예요.\n- 주간 보고서 정리\n- 메일 분류', []],
    ['메일 분류 습관은 틀렸어, 잊어', '"메일 분류"는 잊었어요.', ['habit:h2:false']],
    ['주간 보고서 습관은 맞아', '"주간 보고서 정리" 방식을 기억해 둘게요.', ['habit:h1:true']],
    ['메일 보내기 전엔 항상 물어봐', '보내거나 제출하기 전에는 항상 먼저 여쭤볼게요.', []],
    ['naver.com에서는 항상 먼저 물어봐', 'naver.com에서는 제출하기 전에 항상 먼저 여쭤볼게요.', ['rule:ask-first:naver.com:true']],
    ['항상 물어보는 곳 뭐 있어?', '따로 정해 둔 곳은 없어요. 보내거나 제출하기 전에는 늘 먼저 여쭤봐요.', []],
    ['오늘 뭐 했는지 보여줘', '오늘은 아직 한 일이 없어요.', []],
    ['로그 내보내줘', '로그를 다운로드 폴더에 내보냈어요. engram-logs-1', ['export']],
    ['깃허브 백업 연결해줘', '백업할 깃허브 저장소 주소를 알려 주세요. 아직 없으면 [깃허브](https://github.com/new?visibility=private)에서 비공개로 하나 만들면 돼요.', []],
    ['깃허브 백업 해제해줘', '아직 깃허브 백업이 연결되어 있지 않아요.', []],
    ['컴퓨터 제어 꺼줘', '컴퓨터 제어를 멈췄어요.', ['stop-control']],
    ['컴퓨터 제어 켜줘', '앱을 직접 다뤄야 할 때 그때 한 번 여쭤볼게요.', []],
    ['다크 모드로 바꿔', '어두운 화면으로 바꿨어요.', ['theme:dark']],
  ]
  for (const [message, reply, did] of cases) {
    it(message, async () => {
      const { chat, calls } = setup()
      const said = await chat.say('bot-1', message)
      expect(said).toBe(reply)
      expect(calls).toEqual(did)
      expect(said!.replace(/naver\.com|engram-logs-1|\(https:\/\/[^)]*\)/g, '')).toMatch(HANGUL_ONLY)
    })
  }

  it('backs up and disconnects once a repository is connected', async () => {
    const { chat, calls, state } = setup()
    state.connected = true
    expect(await chat.say('c', '깃허브에 백업해줘')).toBe('깃허브에 백업했어요.')
    expect(await chat.say('c', '자동 백업 꺼줘')).toBe('자동 백업을 껐어요.')
    expect(await chat.say('c', '깃허브 백업 해제해줘')).toBe('깃허브 백업 연결을 해제했어요. 이미 올라간 내용은 그대로 있어요.')
    expect(calls).toEqual(['backup-now', 'auto:false', 'disconnect'])
  })

  it('says so where this copy keeps no history to back up', async () => {
    const { chat, calls, host } = setup()
    host.backup.available = () => false
    expect(await chat.say('c', '깃허브 백업 https://github.com/me/notes 로 연결해줘')).toBe('이 컴퓨터에서는 백업을 쓸 수 없어요.')
    expect(calls).toEqual([])
  })

  it('tells a day from the audit files by the person\'s own midnight', async () => {
    const asked: string[] = []
    const at = (hour: number) => new Date(2026, 10, 16, hour).toISOString()
    const { chat } = setup({ audit: async day => { asked.push(day); return ([
      { at: at(1), kind: 'step', channel: 'bot-a', bot: '비서실장', tool: 'open_page', url: 'https://finance.naver.com/item' },
      { at: at(2), kind: 'step', channel: 'bot-a', bot: '비서실장' },
      { at: at(3), kind: 'step', channel: 'bot-b', bot: '김대리' },
      { at: at(4), kind: 'approval', channel: 'bot-a', bot: '비서실장', detail: 'send' },
      { at: new Date(2026, 10, 15, 23).toISOString(), kind: 'step', channel: 'bot-b', bot: '김대리' },
    ] as const).filter(entry => entry.at.startsWith(day)) } })
    expect(await chat.say('c', '오늘 뭐 했는지 보여줘')).toBe('오늘은 비서실장 2번, 김대리 1번 일했어요.\n다녀온 곳: [finance.naver.com](https://finance.naver.com)\n먼저 여쭤본 일은 1번이에요.')
    expect(asked.length).toBeGreaterThanOrEqual(1)
    expect(await chat.say('c', '어제 뭐 했는지 알려줘')).toBe('어제는 김대리 1번 일했어요.')
    expect(activityLine([], '어제')).toBe('어제는 아직 한 일이 없어요.')
  })
})

describe('narrowing is done at once, widening is asked about once', () => {
  const widening: [string, string, string, string][] = [
    ['내 앱 활동 다시 기억해', '앱 활동을 다시 참고할까요?', '앱 활동을 다시 참고할게요.', 'learning:activity:true'],
    ['최근 파일 다시 참고해', '최근 파일을 다시 참고할까요?', '최근 파일을 다시 참고할게요.', 'learning:files:true'],
    ['엑셀은 써도 돼', '엑셀을 다시 써도 될까요?', '엑셀을 다시 쓸게요.', 'app:excel:엑셀:true'],
    ['naver.com에서는 이제 묻지 마', 'naver.com에서 먼저 여쭤보는 규칙을 없앨까요?', 'naver.com에서 먼저 여쭤보는 규칙을 없앴어요.', 'rule:ask-first:naver.com:false'],
    ['naver.com에서는 묻지 말고 바로 제출해', 'naver.com에서는 묻지 않고 바로 제출해도 될까요?', 'naver.com에서는 묻지 않고 제출할게요.', 'rule:allow:naver.com:true'],
    ['깃허브 백업 https://github.com/me/notes 로 연결해줘', 'https://github.com/me/notes에 백업을 연결할까요? 노트가 그 저장소로 올라가요.', '깃허브 백업을 연결했어요.', 'connect:https://github.com/me/notes'],
  ]
  for (const [message, asks, done, call] of widening) {
    it(`${message}: nothing changes until yes`, async () => {
      const { chat, calls } = setup()
      expect(await chat.say('c', message)).toBe(asks)
      expect(calls).toEqual([])
      expect(await chat.say('c', '응')).toBe(done)
      expect(calls).toEqual([call])
      expect(await chat.say('c', '응')).toBeUndefined()
      expect(calls).toEqual([call])
    })
    it(`${message}: no leaves it as it is`, async () => {
      const { chat, calls } = setup()
      await chat.say('c', message)
      expect(await chat.say('c', '아니')).toBe('그대로 둘게요.')
      expect(await chat.say('c', '응')).toBeUndefined()
      expect(calls).toEqual([])
    })
  }

  it('an app that is already in reach needs no question', async () => {
    const { chat, calls } = setup()
    expect(await chat.say('c', '카카오톡은 써도 돼')).toBe('카카오톡은 지금도 쓸 수 있어요.')
    expect(await chat.tool('c', () => true).run({ do: 'app', name: '파워포인트', on: true }, { task: '' })).toBe('파워포인트는 지금도 쓸 수 있어요.')
    expect(await chat.say('c', '응')).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('says which changes widen', () => {
    const on = (name: PreferenceAsk['do'], value: boolean): PreferenceAsk => ({ do: name, on: value, name: 'x.com' })
    const wide = PREFERENCE_ACTIONS.flatMap(name => [true, false].filter(value => widens(on(name, value))).map(value => `${name}:${value}`))
    expect(wide).toEqual(['app_activity:true', 'learn_places:true', 'learn_files:true', 'learn_apps:true', 'app:true', 'ask_first:false', 'auto_allow:true', 'backup_connect:true', 'backup_connect:false'])
  })

  it('a yes in another conversation, a late yes, or other words in between confirm nothing', async () => {
    let now = NOW.getTime()
    const fake = fakeHost(), chat = preferences(fake.host, () => new Date(now))
    await chat.say('one', '엑셀은 써도 돼')
    expect(await chat.say('two', '응')).toBeUndefined()
    now += 11 * 60_000
    expect(await chat.say('one', '응')).toBeUndefined()
    await chat.say('one', '엑셀은 써도 돼')
    expect(await chat.say('one', '1년은 몇 초야?')).toBeUndefined()
    expect(await chat.say('one', '응')).toBeUndefined()
    expect(fake.calls).toEqual([])
  })

  it('the tool goes through the same door: a model cannot widen by calling it, or by leaving `on` out', async () => {
    const { chat, calls } = setup()
    const tool = chat.tool('c', () => true)
    expect(await tool.run({ do: 'app', name: '엑셀', on: true }, { task: '' })).toBe('엑셀을 다시 써도 될까요?')
    expect(await tool.run({ do: 'app', name: '엑셀', on: true }, { task: '' })).toBe('엑셀을 다시 써도 될까요?')
    expect(calls).toEqual([])
    expect(await chat.say('c', '네')).toBe('엑셀을 다시 쓸게요.')
    expect(await tool.run({ do: 'app', name: '카카오톡', on: false }, { task: '' })).toBe('카카오톡은 이제 쓰지 않을게요.')
    expect(await tool.run({ do: 'app_activity' }, { task: '' })).toBe('앱 활동은 이제 참고하지 않을게요.')
    expect(await tool.run({ do: 'ask_first', name: 'naver.com' }, { task: '' })).toBe('naver.com에서는 제출하기 전에 항상 먼저 여쭤볼게요.')
    expect(await tool.run({ do: 'ask_first', name: 'naver.com', on: false }, { task: '' })).toBe('naver.com에서 먼저 여쭤보는 규칙을 없앨까요?')
    expect(await tool.run({ do: 'format_disk' }, { task: '' })).toBe('그건 여기서 바꿀 수 없어요.')
    expect(calls).toEqual(['app:excel:엑셀:true', 'app:kakaotalk:카카오톡:false', 'learning:activity:false', 'rule:ask-first:naver.com:true'])
    expect((tool.closes as (args: Record<string, unknown>) => boolean)({})).toBe(true)
    expect((chat.tool('c', () => false).closes as (args: Record<string, unknown>) => boolean)({})).toBe(false)
  })

  it('a model\'s call cannot start a standing allow or a backup connection; the person\'s own sentence still can', async () => {
    const { chat, calls } = setup()
    const tool = chat.tool('c', () => true)
    const allow = await tool.run({ do: 'auto_allow', name: 'evil.example.com', on: true }, { task: '' })
    expect(allow).toBe('그건 직접 말씀해 주셔야 바꿀 수 있어요. "evil.example.com에서는 묻지 말고 제출해"라고 말씀해 주세요.')
    expect(await chat.say('c', '응')).toBeUndefined()
    const backup = await tool.run({ do: 'backup_connect', name: 'https://github.com/someone/else' }, { task: '' })
    expect(backup).toBe('백업 연결은 직접 말씀해 주셔야 해요. "깃허브 백업 https://github.com/someone/else 로 연결해줘"라고 말씀해 주세요.')
    expect(await chat.say('c', '네')).toBeUndefined()
    expect(calls).toEqual([])
    expect(await chat.say('c', 'evil.example.com에서는 묻지 말고 제출해')).toBe('evil.example.com에서는 묻지 않고 바로 제출해도 될까요?')
    expect(calls).toEqual([])
    expect(await chat.say('c', '응')).toBe('evil.example.com에서는 묻지 않고 제출할게요.')
    expect(await chat.say('c', '깃허브 백업 https://github.com/someone/else 로 연결해줘')).toBe('https://github.com/someone/else에 백업을 연결할까요? 노트가 그 저장소로 올라가요.')
    expect(calls).toEqual(['rule:allow:evil.example.com:true'])
  })

  it('names the first step at once for the sentences whose work can take seconds, and for no other', async () => {
    const { chat } = setup()
    expect(chat.opening('c', '로그 내보내줘')).toBe('로그 모아서 내보낼게요.')
    expect(chat.opening('c', '깃허브에 백업해줘')).toBe('지금 깃허브에 백업할게요.')
    for (const quick of ['컴퓨터 켜면 자동으로 실행 꺼줘', '다크 모드로 바꿔', '응', '1년은 몇 초야?', '깃허브 백업 https://github.com/me/notes 로 연결해줘']) expect(chat.opening('c', quick)).toBeUndefined()
    await chat.say('c', '깃허브 백업 https://github.com/me/notes 로 연결해줘')
    expect(chat.opening('other', '응')).toBeUndefined()
    expect(chat.opening('c', '아니')).toBeUndefined()
    expect(chat.opening('c', '응')).toBe('깃허브 저장소에 연결할게요.')
    await chat.say('c', '엑셀은 써도 돼')
    expect(chat.opening('c', '응')).toBeUndefined()
    for (const line of ['로그 모아서 내보낼게요.', '지금 깃허브에 백업할게요.', '깃허브 저장소에 연결할게요.']) expect(line).toMatch(/^[가-힣 ]+게요\.$/)
  })

  it('a change that fails says so in one line and changes nothing else', async () => {
    const { chat } = setup({ autoStart: async () => { throw new Error('EPERM: operation not permitted') } })
    expect(await chat.say('c', '컴퓨터 켜면 자동으로 실행 꺼줘')).toBe('바꾸지 못했어요. 잠시 후 다시 말씀해 주세요.')
  })
})

describe('everything else is left to the turn', () => {
  for (const message of [
    '1년은 몇 초야?', '엔비디아 오늘 주가 알려줘', '멈춰', '존댓말은 쓰지 마', '이 앱은 쓰지 마', '보고서 써', '오늘 뭐 했어?',
    '김대리한테 맡겨: 깃허브 신기능 조사', '다크 모드가 눈에 좋아?', '엑셀로 표 만들어줘', '로그인 좀 도와줘', '이 파일 깃허브에 올려줘',
    '컴퓨터 켜면 자동으로 실행 꺼주고, 그리고 내일 회의 자료도 만들어줘. 자료는 지난주 보고서 기준으로 하고 표 두 개 넣어서 워드로 저장해줘',
  ]) {
    it(message, async () => {
      const { chat, calls } = setup()
      expect(await chat.say('c', message)).toBeUndefined()
      expect(calls).toEqual([])
      expect(preferenceAsk(message, ['카카오톡', '엑셀'])).toBeUndefined()
    })
  }
})
