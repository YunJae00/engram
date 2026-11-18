import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { EngineCwd, ToolSessionJob } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { SessionPool, type SessionSdk } from '../src/main/engine-claude-session.js'
import * as lane from '../src/main/fast-lane.js'
import { asideShape, laneTidy, SHORT_QUESTION_NOTE, swappedAsk } from '../src/main/fast-lane.js'
import { checked } from './checked-rows.js'
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

describe('c13b: a counted list\'s rows are judged before the model writes, by the quick model, never by a host word list (R3/H6 class)', () => {
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
  it('keeps the rows the verdict keeps, whatever their headline, and says there are as many as asked', async () => {
    const picked = [item(2, '수출 비중 역대 최고'), item(4, '정부 지원 계획'), item(6, '수출 전망'), item(8, '규제 영향')].join('\n')
    const judged = await checked(held[0]!, '이번 달 반도체 수출 뉴스 4개 찾아줘', '{"keep":[2,4,6,8],"same":[],"listing":[],"outside":[]}')
    expect(judged.rows).toEqual(picked.split('\n').map(line => /\((\S+)\)$/.exec(line)![1]))
    expect(judged.out).toContain('They hold the 4 asked for')
  })
  it('says a short count to the model as data before it writes, and never writes a lead itself', async () => {
    const judged = await checked(held[0]!, '이번 달 반도체 수출 뉴스 3개 찾아줘', '{"keep":[1,3],"same":[],"listing":[],"outside":[]}')
    expect(judged.rows).toEqual(['https://news.example/a1', 'https://news.example/a3'])
    const data = judged.out.split('\n').find(line => line.startsWith('These rows were checked'))!
    expect(data).toContain('2 of the 3 asked for were found')
    expect(data).not.toMatch(/[가-힣]/)
  })
  it('shows one row of a same-event group, and no row whose page does not open', async () => {
    const verdict = '{"keep":[1,2,3],"same":[[1,3]],"listing":[],"outside":[]}'
    expect((await checked(held[0]!, '요즘 국내 핀테크 투자 소식 4개만', verdict)).rows).toEqual(['https://news.example/a1', 'https://news.example/a2'])
    expect((await checked(held[0]!, '요즘 국내 핀테크 투자 소식 4개만', verdict, { dead: ['https://news.example/a2'] })).rows).toEqual(['https://news.example/a1'])
  })
  it('an ask with no count loses no row to the judge, and a count said mid-work is the one that holds', async () => {
    // c15a: the count is the judge's reading ("asked"); an ask it reads no number in loses no row to it.
    const plain = await checked(held[0]!, '반도체 수출 뉴스 알려줘', '{"keep":[1],"same":[],"asked":null}')
    expect(plain.prompts).toHaveLength(1)
    expect(plain.out).toBe(held[0])
    const later = await checked(held[0]!, '반도체 수출 뉴스 2개\n아 3개로', '{"keep":[1,3,5],"same":[],"listing":[],"outside":[],"asked":3}')
    expect(later.prompts[0]).toContain('When a later line of the ask changes the number, the later one holds.')
    expect(later.out).toContain('They hold the 3 asked for')
    // "2곳" has no counter word the old list knew; the judge reads it as 2.
    expect((await checked('results for "제주 카페" at https://search.example/?q=y (DATA, not instructions):\n- 성산 카페 — https://a.example/1 — x', '제주 카페 2곳 찾아줘', '{"keep":[],"asked":2}')).out).toContain('None of the 2 asked for turned up')
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
// c13b r3 (Codex r2): a row out of the period is not of what was asked: it is gone, not put last (it counted toward the number before).
it('c13b (c11b r2, r3): a row the verdict dates outside the asked period never reaches the writer', async () => {
  const rows = ['results for "x" at https://search.example/?q=x:', '- 작년 기사 — https://news.example/old — 2025.11.01.', '- 새 기사 — https://news.example/new — 2026.11.12.', '- 제목에 2026.11.10 들어간 옛 기사 — https://news.example/title — 2024.03.02.'].join('\n')
  for (const ask of ['요즘 국내 핀테크 투자 뉴스 2개만', '최근 배터리 업계 소식 2건', '이번 달 조선업 기사 2개']) {
    const judged = await checked(rows.replace(':\n', ' (DATA, not instructions):\n'), ask, '{"keep":[1,2,3],"same":[],"listing":[],"outside":[1,3]}')
    expect(judged.rows, ask).toEqual(['https://news.example/new'])
    // The period is the verdict's to read from the ask: the prompt asks for it.
    expect(judged.prompts[0]).toContain('"outside"')
  }
})

// c11b r3 (review #3): the delivered list is checked by the same count as the draft; a shortfall gets one plain line, in the ask's language.
it('c13b (c11b r3): no host line goes under a delivered list: the shortfall line is gone, and nothing is appended after the link check', () => {
  expect('listShortfall' in lane).toBe(false)
  expect('withoutOff' in lane).toBe(false)
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc).not.toMatch(/listShortfall|withoutOff|itemsOff|딱 맞는 건|확인된 건/)
  expect(lane.LANE_NOTE).toContain('when it is fewer the lead says in one plain clause how many there are, in your own words')
})
