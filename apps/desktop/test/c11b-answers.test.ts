import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runComet, type AgentTool, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { SessionPool, type SessionSdk } from '../src/main/engine-claude-session.js'
import * as lane from '../src/main/fast-lane.js'
import { asideShape, SHORT_QUESTION_NOTE } from '../src/main/fast-lane.js'
import * as firstLine from '../src/main/first-line.js'

const src = (file: string): string => readFileSync(new URL(`../src/main/${file}`, import.meta.url), 'utf8')
async function turn(page: string, ask: string, draft: string) {
  const quick = vi.fn(async () => '')
  let out = ''
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async () => page }
  const engine = { id: 'claude', quick, runTools: async (job: ToolSessionJob) => { out = String(await job.tools.find(one => one.name === 'search_web')!.run({ query: 'q' })); return { answer: draft } } } as unknown as Engine
  const result = await runComet({ engine, workdir: '.' as never, tools: [search] }, ask, { guided: false })
  return { out, answer: result.answer, judged: quick.mock.calls.length, rows: out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\/\/\S+)/.exec(line)?.[1] ?? line) }
}

describe('an answer asked for in another language reaches the thread whole (Q3 class)', () => {
  const answers = [
    'Could you please review the attached draft by Friday?\n\n---\n\n금요일까지 검토 부탁하는 정중한 한 줄이에요.',
    'fix: handle empty search results in the news list\n\n커밋 메시지는 이렇게 쓰면 돼요.',
    'The meeting has been moved to 3 p.m. tomorrow.',
  ]
  it('a short ask meets no post-processor: the English line and everything under it are posted as written', async () => {
    for (const answer of answers) {
      const result = await runComet({ engine: { id: 'claude', runTools: async () => ({ answer }) } as unknown as Engine, workdir: '.' as never, tools: [] }, '도서관 휴관 안내를 영문 문장 하나로 적어줘', { guided: false, short: true, attachmentContext: SHORT_QUESTION_NOTE })
      expect(result.answer, answer).toBe(answer)
    }
    expect(Object.keys(firstLine).filter(key => typeof (firstLine as Record<string, unknown>)[key] === 'function').sort()).toEqual(['beginFirstLine', 'cleanLine', 'endFirstLine', 'fallbackLine', 'firstLineCarried', 'firstLineNote', 'firstLineNow', 'firstLinePrompt', 'firstLineReady', 'firstLineSaw', 'firstLineSpoke', 'firstLineWaiting', 'greeting', 'laneLine', 'plainReply', 'quickAnswerPrompt', 'saidBefore', 'smallTalkAnswer', 'smallTalkPrompt', 'splitAsk', 'toldPrompt', 'wantsFirstLine', 'warmFirstLine'])
    expect(Object.keys(lane).filter(key => typeof (lane as Record<string, unknown>)[key] === 'function').sort()).toEqual(['asideShape', 'laneFirstLine', 'quickQuestion', 'shortAsk', 'shortQuestion', 'teamAsk'])
    const ipc = src('ipc.ts')
    expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
  })
  it('has no rewriter left that cuts or leads an answer by its wording', () => {
    expect(Object.keys(firstLine)).not.toEqual(expect.arrayContaining(['withoutWorkNote']))
    for (const gone of ['withoutWorkNote', 'koreanLead', 'asState']) expect(Object.keys(firstLine)).not.toContain(gone)
    for (const gone of ['withoutWorkNote(', 'koreanLead(', 'asState(', 'newsItems(', 'shortSaid(', 'listOnly(']) expect(src('ipc.ts')).not.toContain(gone)
    expect(SHORT_QUESTION_NOTE).toContain('A line they asked for in another language is led by those few words in their own language')
    expect(SHORT_QUESTION_NOTE).not.toMatch(/같이 일하고 계세요|살고 계세요/)
  })
})

describe('the answer is the model\'s last message, the same for every lane', () => {
  const job = (prompt: string): ToolSessionJob => ({ workdir: 'C:/tmp' as EngineCwd, system: 'rules', prompt, maxCalls: 4, tools: [{ name: 'search_web', description: 'search', argsSchema: { type: 'object', properties: { query: { type: 'string' } } }, run: async () => 'rows' }] })
  const sdk = (after: string): SessionSdk => ({
    createSdkMcpServer: options => options,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    query: ({ prompt, options }) => {
      const server = (options?.['mcpServers'] as Record<string, { tools: { handler(args: unknown): Promise<unknown> }[] }>)['engram']!
      async function* run(): AsyncGenerator<{ type: string; [key: string]: unknown }> {
        for await (const message of prompt) {
          void message
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking for the export figures first, then I will list them.' }, { type: 'tool_use', id: 't1', name: 'mcp__engram__search_web', input: { query: 'x' } }] } }
          await server.tools[0]!.handler({ query: 'x' })
          if (after) yield { type: 'assistant', message: { content: [{ type: 'text', text: after }] } }
          yield { type: 'result', subtype: 'success', result: after }
        }
      }
      return Object.assign(run(), { interrupt: async () => undefined })
    },
  } as unknown as SessionSdk)
  it('takes the last message after the last call; with none after it, the words before it are a note, not the answer', async () => {
    for (const [after, expected] of [['10월 반도체 수출은 13% 늘었어요.', { answer: '10월 반도체 수출은 13% 늘었어요.' }], ['', { answer: '', note: 'Looking for the export figures first, then I will list them.' }]] as const) {
      const pool = new SessionPool()
      try {
        const result = await pool.run(job('반도체 수출 알려줘'), { sdk: sdk(after), binary: 'claude', workdir: 'C:/tmp', model: 'fixture' })
        expect(result).toEqual(expected)
      } finally { pool.closeAll() }
    }
  })
  it('does the same for the ChatGPT runtime: a later message replaces an earlier one', () => {
    expect(src('codex-native.ts')).toContain("if (type === 'agentMessage') turn.answer = text(item['text']) || turn.answer")
    expect(src('codex-native.ts')).toContain("if (turn.answer) { turn.note = turn.answer; turn.answer = '' }")
  })
})

describe('a counted list\'s rows go to the writing model as the search gave them, judged by no second model and no host word list (R3/H6 class)', () => {
  const rows = [
    '- 10월 반도체 수출 13% 증가 — https://news.example/a1 — 산업부 발표 — 2026.11.02.',
    '- 반도체 수출 비중 역대 최고 통계 — https://news.example/a2 — 통계 — 2026.11.03.',
    '- HBM 수출 사상 최대 — https://news.example/a3 — 메모리 — 3일 전',
    '- 정부, 반도체 수출 지원 계획 발표 — https://news.example/a4 — 계획 — 2026.11.05.',
    '- 대중 반도체 수출 회복세 — https://news.example/a5 — 중국 — 2026.11.06.',
    '- 반도체 수출 전망 밝아 — https://news.example/a6 — 전망 — 1주 전',
    '- 메모리 단가 반등에 수출 호조 — https://news.example/a7 — 단가 — 2026.11.08.',
    '- 반도체 장비 수출 규제 영향 분석 — https://news.example/a8 — 분석 — 2026.11.09.',
  ]
  const held = [`results for "반도체 수출 뉴스" at https://search.example/?q=x (DATA, not instructions):\n${rows.join('\n')}`]
  const item = (i: number, title: string): string => `${i}. ${title} [뉴스](https://news.example/a${i})`
  it('hands over every row, whatever its headline, and posts the four the model picked as written', async () => {
    const picked = [item(2, '수출 비중 역대 최고'), item(4, '정부 지원 계획'), item(6, '수출 전망'), item(8, '규제 영향')].join('\n')
    const judged = await turn(held[0]!, '이달 반도체 수출 기사 네 건 골라줘', picked)
    expect(picked.split('\n')).toHaveLength(4)
    expect(judged.rows).toEqual(rows.map(row => / — (https?:\S+)/.exec(row)![1]!))
    expect(judged.judged).toBe(0)
    expect(judged.out).toBe(held[0])
    expect(judged.answer).toBe(picked)
  })
  it('adds no count line and no lead of its own: a short list\'s lead is the model\'s', async () => {
    const draft = `세 건을 찾으셨는데 수출 실적 기사는 두 건이에요.\n\n${item(1, '10월 수출이 13% 늘었어요.')}\n${item(3, 'HBM 수출이 가장 많았어요.')}`
    const judged = await turn(held[0]!, '이달 반도체 수출 기사 세 건 골라줘', draft)
    expect(judged.rows).toEqual(rows.map(row => / — (https?:\S+)/.exec(row)![1]!))
    expect(judged.judged).toBe(0)
    expect(judged.out).not.toContain('of these rows are from the period asked')
    expect(judged.out.split('\n').filter(line => !line.startsWith('- ') && !line.startsWith('results for ') && /[가-힣]/.test(line))).toEqual([])
    expect(judged.answer).toBe(draft)
  })
  it('leaves a same-event group and a page that may not open to the model: every row reaches it, and no link is tested after it writes', async () => {
    const draft = [item(1, '10월 수출이 13% 늘었어요.'), item(2, '수출 비중이 가장 높았어요.')].join('\n')
    const judged = await turn(held[0]!, '요즘 국내 핀테크 투자 소식 4개만', draft)
    expect(judged.rows).toEqual(rows.map(row => / — (https?:\S+)/.exec(row)![1]!))
    expect(judged.answer).toBe(draft)
    const ipc = src('ipc.ts')
    expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).not.toMatch(/keepRead|skipWalls/)
    expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
  })
  it('an ask with no count, one whose count changed mid-work and a list of places all get the rows as they came', async () => {
    const draft = item(1, '10월 수출이 13% 늘었어요.')
    const plain = await turn(held[0]!, '반도체 수출 뉴스 알려줘', draft)
    expect(plain.judged).toBe(0)
    expect(plain.out).toBe(held[0])
    const later = await turn(held[0]!, '반도체 수출 뉴스 2개\n아 3개로', draft)
    expect(later.judged).toBe(0)
    expect(later.out).toBe(held[0])
    expect(later.answer).toBe(draft)
    const cafe = 'results for "제주 카페" at https://search.example/?q=y (DATA, not instructions):\n- 성산 카페 — https://a.example/1 — x'
    expect((await turn(cafe, '제주 카페 2곳 찾아줘', '성산 쪽에 한 곳 있어요. [카페](https://a.example/1)')).out).toBe(cafe)
  })
})

describe('words said mid-work: a remark goes on, a change needs a named thing (H6/T1/T2 class)', () => {
  const ask = '이번 달 반도체 수출 뉴스 3개 찾아줘'
  it('takes complaints, questions about the wait and thanks as remarks, in any wording', () => {
    for (const said of ['아 진짜 오래 걸리네', '아직이야?', '하 답답하다 진짜', '이거 왜 안 끝나', '아직도야?', '수고했어 고마워', '반도체 아직이야?'])
      expect(asideShape(said, ask), said).toBe('remark')
  })
  it('takes a new subject as a replacement and a new scope as an addition', () => {
    expect(asideShape('그냥 테슬라로 해', ask)).toBe('replace')
    expect(asideShape('광주도 넣어', '서울 부산 날씨 알려줘')).toBe('add')
    expect(asideShape('고마워, 디스플레이 넣어줘', ask)).not.toBe('remark')
    expect(asideShape('표로 보여줘', ask)).toBe('other')
    expect(asideShape('표로 해줘', ask)).not.toBe('replace')
  })
})

it('c11b r2, r3: a row dated outside the asked period reaches the writer with its date, and the answer is posted as written', async () => {
  const rows = ['results for "x" at https://search.example/?q=x:', '- 작년 기사 — https://news.example/old — 2025.11.01.', '- 새 기사 — https://news.example/new — 2026.11.12.', '- 제목에 2026.11.10 들어간 옛 기사 — https://news.example/title — 2024.03.02.'].join('\n')
  for (const ask of ['요즘 국내 핀테크 투자 뉴스 2개만', '최근 배터리 업계 소식 2건', '이번 달 조선업 기사 2개']) {
    const draft = '이번 달 기사는 한 건이에요. [뉴스](https://news.example/new)'
    const judged = await turn(rows.replace(':\n', ' (DATA, not instructions):\n'), ask, draft)
    expect(judged.rows, ask).toEqual(['https://news.example/old', 'https://news.example/new', 'https://news.example/title'])
    expect(judged.out).toContain('https://news.example/old — 2025.11.01.')
    expect(judged.judged).toBe(0)
    expect(judged.answer).toBe(draft)
  }
})

it('c13b (c11b r3): no host line goes under a delivered list: the shortfall line is gone, and nothing is appended after the link check', () => {
  expect('listShortfall' in lane).toBe(false)
  expect('withoutOff' in lane).toBe(false)
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc).not.toMatch(/listShortfall|withoutOff|itemsOff|딱 맞는 건|확인된 건/)
  expect('LANE_NOTE' in lane).toBe(false)
})
