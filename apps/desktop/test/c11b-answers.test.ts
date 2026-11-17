import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { EngineCwd, ToolSessionJob } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { SessionPool, type SessionSdk } from '../src/main/engine-claude-session.js'
import { asideShape, laneTidy, listGap, listShortfall, SHORT_QUESTION_NOTE, swappedAsk } from '../src/main/fast-lane.js'
import * as firstLine from '../src/main/first-line.js'

// c11b: the host never deletes or rewrites what the model said by its wording. All wordings here are not in the harness.
const src = (file: string): string => readFileSync(new URL(`../src/main/${file}`, import.meta.url), 'utf8')

describe('an answer asked for in another language reaches the thread whole (Q3 class)', () => {
  const answers = [
    'Could you please review the attached draft by Friday?\n\n---\n\n금요일까지 검토 부탁하는 정중한 한 줄이에요.',
    'fix: handle empty search results in the news list\n\n커밋 메시지는 이렇게 쓰면 돼요.',
    'The meeting has been moved to 3 p.m. tomorrow.',
  ]
  it('keeps the English line through every post-processor a short ask still meets', () => {
    for (const answer of answers) {
      const out = laneTidy(firstLine.answerAlone(answer))
      expect(out.split('\n')[0], answer).toBe(answer.split('\n')[0])
    }
  })
  it('has no rewriter left that cuts or leads an answer by its wording', () => {
    expect(Object.keys(firstLine)).not.toEqual(expect.arrayContaining(['withoutWorkNote']))
    for (const gone of ['withoutWorkNote', 'koreanLead', 'asState']) expect(Object.keys(firstLine)).not.toContain(gone)
    for (const gone of ['withoutWorkNote(', 'koreanLead(', 'asState(', 'newsItems(', 'shortSaid(', 'listOnly(']) expect(src('ipc.ts')).not.toContain(gone)
    // What the model is given instead: a few words in the person's language on the same line, and no template phrase about the person.
    expect(SHORT_QUESTION_NOTE).toContain('A line they asked for in another language is led by those few words in their own language')
    expect(SHORT_QUESTION_NOTE).not.toMatch(/같이 일하고 계세요|살고 계세요/)
  })
})

describe('the answer is the model\'s last message, the same for every lane', () => {
  const job = (prompt: string): ToolSessionJob => ({ workdir: 'C:/tmp' as EngineCwd, system: 'rules', prompt, maxCalls: 4, tools: [{ name: 'search_web', description: 'search', argsSchema: { type: 'object', properties: { query: { type: 'string' } } }, run: async () => 'rows' }] })
  // A stand-in runtime that writes a note beside a tool call, runs it, and then writes `after` (or nothing) as its last message.
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
  // c11b r2 (review #3): with nothing after the call, the words before it are a note, never the answer (runToolSession then asks for one).
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
    // c11b r2: and words before an action are moved out of the answer into the note.
    expect(src('codex-native.ts')).toContain("if (turn.answer) { turn.note = turn.answer; turn.answer = '' }")
  })
})

describe('a counted list is checked by its shape, never by its words or topic (R3/H6 class)', () => {
  // Eight dated rows on export news; half are the kind of headline the old eventRank kept out (a statistic, a plan, an outlook).
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
  const now = new Date('2026-11-17T12:00:00+09:00')
  it('takes the items the model picked, whatever their headline, when there are as many as asked', () => {
    const picked = [item(2, '수출 비중 역대 최고'), item(4, '정부 지원 계획'), item(6, '수출 전망'), item(8, '규제 영향')].join('\n')
    expect(listGap(picked, ['이번 달 반도체 수출 뉴스 4개 찾아줘'], held, now)).toBeUndefined()
  })
  it('names the gap for a short list, and never writes a lead or drops an item itself', () => {
    const two = [item(1, '수출 13% 증가'), item(3, 'HBM 최대')].join('\n')
    const gap = listGap(`두 건 찾았어요.\n\n${two}`, ['이번 달 반도체 수출 뉴스 3개 찾아줘'], held, now)
    expect(gap).toMatch(/They asked for 3; 2 of/)
    expect(gap).toContain('its own article link (not a search page) and its date')
  })
  it('counts no search page, no repeated link and no undated item from outside the rows', () => {
    const answer = [item(1, '수출 증가'), '2. 수출 소식 [검색](https://search.naver.com/search.naver?query=x)', item(1, '수출 증가 다시'), '4. 새 기사 [뉴스](https://other.example/z)'].join('\n')
    expect(listGap(answer, ['요즘 국내 핀테크 투자 소식 4개만'], held, now)).toMatch(/They asked for 4; 1 of/)
    // Its own date inside the period makes the outside item count.
    expect(listGap([item(1, '수출 증가'), '2. 새 기사 11월 10일 [뉴스](https://other.example/z)'].join('\n'), ['요즘 국내 핀테크 투자 소식 2개만'], held, now)).toBeUndefined()
  })
  it('asks to trim a list longer than asked, and leaves an ask with no count alone', () => {
    const three = [item(1, 'a'), item(3, 'b'), item(5, 'c')].join('\n')
    expect(listGap(three, ['반도체 수출 뉴스 2개'], held, now)).toMatch(/lists 3. Keep the 2/)
    expect(listGap(three, ['반도체 수출 뉴스 알려줘'], held, now)).toBeUndefined()
    // A count said mid-work is the one that holds; a list that is not news needs no date.
    expect(listGap(three, ['반도체 수출 뉴스 2개', '아 3개로'], held, now)).toBeUndefined()
    expect(listGap('1. 성산 [a](https://a.example/1)\n2. 애월 [b](https://b.example/2)', ['제주 카페 2곳 찾아줘'], [], now)).toBeUndefined()
  })
})

describe('words said mid-work: a remark goes on, a change needs a named thing (H6/T1/T2 class)', () => {
  const ask = '이번 달 반도체 수출 뉴스 3개 찾아줘'
  it('takes complaints, questions about the wait and thanks as remarks, in any wording', () => {
    for (const said of ['아 진짜 오래 걸리네', '아직이야?', '하 답답하다 진짜', '이거 왜 안 끝나', '아직도야?', '수고했어 고마워', '반도체 아직이야?'])
      expect(asideShape(said, ask), said).toBe('remark')
    for (const said of ['아 진짜 오래 걸리네', '아직이야?']) expect(swappedAsk(ask, said)).toBeUndefined()
  })
  it('takes a new subject as a replacement and a new scope as an addition', () => {
    expect(asideShape('그냥 테슬라로 해', ask)).toBe('replace')
    expect(swappedAsk('엔비디아 오늘 주가 알려줘', '그냥 테슬라로 해')).toBe('테슬라 오늘 주가 알려줘')
    expect(asideShape('광주도 넣어', '서울 부산 날씨 알려줘')).toBe('add')
    // Thanks with a job behind it is that job; a form is not a new subject.
    expect(asideShape('고마워, 디스플레이 넣어줘', ask)).not.toBe('remark')
    expect(asideShape('표로 보여줘', ask)).toBe('other')
    expect(swappedAsk(ask, '표로 해줘')).toBeUndefined()
  })
})

// c11b r2 (review #2): a dated search row passed whatever its date; a November 2025 row answered a "요즘" ask in November 2026.
it('c11b r2: an item counts only when its date, from its search row or as written, is inside the period the ask names', () => {
  const now = new Date('2026-11-17T12:00:00+09:00')
  const rows = ['results for "x" at https://search.example/?q=x:', '- 작년 기사 — https://news.example/old — 2025.11.01.', '- 새 기사 — https://news.example/new — 2026.11.12.', '- 제목에 2026.11.10 들어간 옛 기사 — https://news.example/title — 2024.03.02.'].join('\n')
  // The review's own repro, then other wordings and periods.
  expect(listGap('1. 작년 기사 [뉴스](https://news.example/old)', ['요즘 국내 핀테크 투자 뉴스 1개만'], [rows], now)).toMatch(/^They asked for 1; 0 of .*inside the period/)
  expect(listGap('1. 새 기사 [뉴스](https://news.example/new)', ['요즘 국내 핀테크 투자 뉴스 1개만'], [rows], now)).toBeUndefined()
  // A date written in the answer does not overrule the row's own date.
  expect(listGap('1. 작년 기사 (11월 15일) [뉴스](https://news.example/old)', ['최근 배터리 업계 소식 1건'], [rows], now)).toMatch(/0 of/)
  // A date inside a title is not the row's date.
  expect(listGap('1. 옛 기사 [뉴스](https://news.example/title)', ['이번 달 조선업 기사 1개'], [rows], now)).toMatch(/0 of/)
  // An item outside the rows: its written date must be readable and in the period.
  expect(listGap('1. 바깥 기사 2025.12.01 [뉴스](https://else.example/a)', ['요즘 게임 업계 소식 1개'], [rows], now)).toMatch(/0 of/)
  expect(listGap('1. 바깥 기사 2026.11.16 [뉴스](https://else.example/b)', ['요즘 게임 업계 소식 1개'], [rows], now)).toBeUndefined()
  // No period word in a news ask: the default year window still drops a two-year-old row.
  expect(listGap('1. 옛 기사 [뉴스](https://news.example/title)', ['조선업 기사 1개 찾아줘'], [rows], now)).toMatch(/0 of/)
})

// c11b r3 (review #3): the delivered list is checked by the same count as the draft; a shortfall gets one plain line, in the ask's language.
it('c11b r3: listShortfall names how many of the asked items met the ask, and nothing when all did', () => {
  const now = new Date('2026-11-17T12:00:00+09:00')
  const held = ['results for x at https://search.example/?q=x:\n- 해운 운임 반등 — https://sea.example/1 — 2026.11.12.\n- 작년 운임 — https://sea.example/old — 2025.10.02.']
  const answer = '1. 해운 운임 반등 [기사](https://sea.example/1)\n2. 작년 운임 [기사](https://sea.example/old)\n3. 검색 [더보기](https://search.example/?q=x)'
  expect(listShortfall(answer, ['이번 달 해운 운임 기사 3개만 알려줘'], held, now)).toBe('기사 링크와 날짜까지 확인된 건 3개 중 1개예요.')
  expect(listShortfall('1. a [x](https://a.example/1)\n2. b [y](https://b.example/2)', ['캠핑 의자 추천 2개'], [], now)).toBeUndefined()
  expect(listShortfall('1. a [x](https://a.example/1)', ['top 2 camping chair reviews'], [], now)).toBe('1 of the 2 asked for are found with their own link.')
  expect(readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')).toMatch(/liveCited\([^]*?listShortfall\(result\.answer/)
})
