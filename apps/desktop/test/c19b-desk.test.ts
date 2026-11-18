import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { messageUnits, officeTools, runToolSession, wellFormed, type AgentTool, type Engine, type EngineCwd, type ToolSessionJob, type ToolSessionResult } from 'core'
import { builtLine, checkedDesk, closingBuilds, onceEach, reshapeAsk, withPart, withoutQuoted } from '../src/main/desk-lane.js'

const CHECK = 'Judge meaning only', REPAIR = 'You fix a message before a person reads it'
const quickOf = (check: (string | undefined)[], repair: (string | undefined)[]) => {
  const prompts: string[] = []
  return { prompts, quick: async (p: string) => { prompts.push(p); return p.includes(CHECK) ? check.shift() ?? '{"problems":[]}' : p.includes(REPAIR) ? repair.shift() : undefined } }
}
const problems = (...list: Record<string, unknown>[]): string => JSON.stringify({ problems: list })

describe('item 1: a desk answer\'s ```replies block is not prose', () => {
  const REPLIES = ['```replies', '두부도 넣어줘', '양 좀 줄여줘', '```'].join('\n')
  const SOURCE = '장보기: 대파 한 단, 계란 한 판, 우유 1L, 두부'
  const DRAFT = ['장보기 목록만 뽑았어요.', '', '- 대파 한 단', '- 계란 한 판', '- 우유 1L', '', REPLIES].join('\n')
  it('the H2 shape (the check quotes the whole block as "asks") leaves the block byte-identical, on the desk check\'s own removal path too', async () => {
    for (const quote of [REPLIES, '```replies', '두부도 넣어줘', '```']) {
      const blank = JSON.stringify({ replace: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), ''])) })
      const { quick } = quickOf([problems({ kind: 'asks', quote, why: '선택지' })], [blank])
      const out = await checkedDesk({ ask: '장보기 목록만 뽑아줘', draft: DRAFT, source: SOURCE, fromSource: true, quick, since: Date.now() })
      expect(out.endsWith(REPLIES), quote).toBe(true)
      expect(wellFormed(out)).toBe(true)
      expect(withoutQuoted(DRAFT, [{ kind: 'asks', quote, why: '' }])).toContain(REPLIES)
    }
  })
  it('a missing part is added above the trailing block, never after it', () => {
    const out = withPart(DRAFT, { quote: '같이 살 것', lines: ['두부'] }, SOURCE)
    expect(out.endsWith(`같이 살 것\n- 두부\n\n${REPLIES}`)).toBe(true)
  })
})

describe('item 2: a repair never copies a source line under a second part', () => {
  const SOURCE = ['# 하반기 워크숍 회의록', '', '## 결정', '- 워크숍 장소는 양평 연수원으로 확정', '- 1박 2일 일정으로 진행', '',
    '## 업무', '- 숙소 예약 — 윤서아, 11월 25일', '- 버스 대절 견적 — 마도윤, 11월 27일', '- 프로그램 초안 — 강예린, 12월 1일'].join('\n')
  const ASK = '워크숍 회의록에서 결정이랑 담당 업무 나눠서 정리해줘'
  const DRAFT = ['워크숍 회의 정리했어요.', '', '결정', '- 워크숍 장소는 양평 연수원으로 확정', '- 1박 2일 일정으로 진행', '- 숙소 예약 — 윤서아, 11월 25일', '- 버스 대절 견적 — 마도윤, 11월 27일', '- 프로그램 초안 — 강예린, 12월 1일'].join('\n')
  const TASKS = ['- 숙소 예약 — 윤서아, 11월 25일', '- 버스 대절 견적 — 마도윤, 11월 27일', '- 프로그램 초안 — 강예린, 12월 1일']
  const reworded = ['- 윤서아 님이 숙소 예약을 11월 25일까지 해요', '- 마도윤 님이 버스 대절 견적을 11월 27일까지 받아요', '- 강예린 님이 프로그램 초안을 12월 1일까지 써요']
  it('the reworded copy is refused and every task line stands once, under 담당 업무', async () => {
    const units = messageUnits(DRAFT)
    const copy = JSON.stringify({ insert_after: { [String(units.length)]: ['', '담당 업무', ...reworded] } })
    const { quick } = quickOf([problems({ kind: 'missing', quote: '담당 업무', why: '없음', lines: TASKS })], [copy])
    const out = await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, fromSource: true, quick, since: Date.now() })
    expect(out).not.toContain('님이')
    for (const task of TASKS) expect(out.split('\n').filter(line => line === task)).toHaveLength(1)
    const [decided, tasks] = out.split('담당 업무')
    expect(TASKS.every(task => tasks!.includes(task) && !decided!.includes(task))).toBe(true)
    expect(onceEach(out, SOURCE)).toBe(true)
  })
  it('onceEach tells a reworded copy from two different lines', () => {
    expect(onceEach([...TASKS, ...reworded].join('\n'), SOURCE)).toBe(false)
    expect(onceEach(TASKS.join('\n'), SOURCE)).toBe(true)
  })
})

describe('item 3: a shorter reshape keeps the meaning check, and its repair must keep the shorter form', () => {
  const ASK = '택배 늦어서 미안하다는 문자 한 줄 써줘'
  const LAST = '고객님, 택배 배송이 늦어져서 정말 죄송합니다. 최대한 빨리 받아보실 수 있도록 하겠습니다.'
  // Round 2 (r1 #1): the shorter draft is checked like every other form; a repair that only brings the longer reply back is refused.
  it('a clean shorter draft goes out after one check (2 calls); a rewrite to the original is never shown', async () => {
    const short = '택배가 늦어져 죄송합니다. 곧 받아보시게 할게요.'
    const calls: string[] = []
    const quick = async (prompt: string): Promise<string> => {
      calls.push(prompt)
      if (prompt.includes(CHECK)) return calls.length === 2 ? problems() : problems({ kind: 'dropped', quote: short, why: '' })
      if (prompt.includes(REPAIR)) return JSON.stringify({ replace: { '1': LAST } })
      return JSON.stringify({ form: 'shorter', was: LAST, reply: short })
    }
    expect(await reshapeAsk('좀 더 줄여줘', LAST, quick, ASK)).toBe(short)
    expect(calls).toHaveLength(2)
    calls.length = 0
    const flagged = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? problems({ kind: 'dropped', quote: short, why: '' }) : prompt.includes(REPAIR) ? JSON.stringify({ replace: { '1': LAST } }) : JSON.stringify({ form: 'shorter', was: LAST, reply: short }) }
    expect(await reshapeAsk('좀 더 줄여줘', LAST, flagged, ASK)).toBeUndefined()
  })
  it('a shorter draft that drops the ask\'s audience is caught and repaired in the shorter form (not the harness wording)', async () => {
    const ask = '할머니께 보낼 생신 축하 문자 존댓말로 써줘', last = '할머니, 생신 진심으로 축하드려요. 늘 건강하시고 오래오래 저희 곁에 계셔 주세요. 사랑해요.'
    const casual = '할머니 생일 축하해! 건강해.', fixed = '할머니, 생신 축하드려요. 건강하세요.'
    const { quick, prompts } = quickOf([problems({ kind: 'dropped', quote: casual, why: '존댓말이 아니에요' }), problems()], [JSON.stringify({ replace: { '1': '할머니, 생신 축하드려요.', '2': '건강하세요.' } })])
    const voice = async (p: string): Promise<string> => p.includes(CHECK) || p.includes(REPAIR) ? (await quick(p)) ?? '' : JSON.stringify({ form: 'shorter', was: last, reply: casual })
    expect(await reshapeAsk('더 짧게 해줘', last, voice, ask)).toBe(fixed)
    expect(prompts.some(p => p.includes(CHECK) && p.includes('존댓말로'))).toBe(true)
  })
  it('on the Q4 latencies (1.7 s draft, 1.2 s check) the reshape ends under 4 s with 2 calls', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const quick = (prompt: string): Promise<string> => { calls++; const check = prompt.includes(CHECK); return new Promise(resolve => setTimeout(() => resolve(check ? problems() : JSON.stringify({ form: 'shorter', was: LAST, reply: '배송 늦어 죄송해요.' })), check ? 1200 : 1700)) }
      const began = Date.now(), out = reshapeAsk('좀 더 줄여줘', LAST, quick, ASK)
      await vi.advanceTimersByTimeAsync(2900)
      expect(await out).toBe('배송 늦어 죄송해요.')
      expect(Date.now() - began).toBeLessThan(4000)
      expect(calls).toBe(2)
    } finally { vi.useRealTimers() }
  })
  it('a draft that was not shorter takes the usual route', async () => {
    const quick = async (): Promise<string> => JSON.stringify({ form: 'shorter', was: LAST, reply: `${LAST} 감사합니다.` })
    expect(await reshapeAsk('좀 더 줄여줘', LAST, quick, ASK)).toBeUndefined()
  })
  it('another form keeps the meaning check, and its repair must keep the form: a rewrite back to the last reply is refused', async () => {
    const polite = '택배 배송이 늦어져 정말 죄송해요. 최대한 빨리 받아보시게 할게요.'
    const { quick, prompts } = quickOf([problems({ kind: 'dropped', quote: '택배 배송이 늦어져 정말 죄송해요.', why: '' })], [JSON.stringify({ replace: { '1': LAST.split('. ')[0] + '.', '2': '최대한 빨리 받아보실 수 있도록 하겠습니다.' } })])
    const voice = async (p: string): Promise<string> => p.includes(CHECK) || p.includes(REPAIR) ? (await quick(p)) ?? '' : JSON.stringify({ form: 'tone', was: LAST, reply: polite })
    expect(await reshapeAsk('좀 부드럽게', LAST, voice, ASK)).toBeUndefined()
    expect(prompts.some(p => p.includes(CHECK))).toBe(true)
  })
})

describe('item 4: a build the host audit passed closes the turn', () => {
  const WORKDIR = '/Users/kwon-yunjae/engram-orch/tmp/c19b' as EngineCwd
  const brain = (script: (job: ToolSessionJob) => Promise<ToolSessionResult>): Engine => ({ id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: script }) as unknown as Engine
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const receipt = { artifact: 'a1', path: '/out/신제품 소개.pptx', markdownLink: '[신제품 소개.pptx](engram-artifact:a1)', completeReadback: true }
  const deckTools = (delay = 0) => officeTools({ run: async () => { await pause(delay); return receipt } })
  const SLIDES = [{ title: '신제품 소개', subtitle: '마케팅팀' }, { title: '핵심 기능', bullets: ['한 번 충전으로 3일 사용', '방수 등급 IP68'] }, { title: '출시 일정', bullets: ['12월 첫 주 사전 예약'] }]
  const reader = () => { const read = { name: 'file_read_package', description: 'reads a package', argsSchema: { type: 'object' }, calls: 0, run: async () => { read.calls++; return '{}' } }; return read }
  const run = async (tools: AgentTool[], args: Record<string, unknown>, name = 'ppt_build') => {
    const read = reader()
    let after = 0
    const engine = brain(async job => {
      await job.tools.find(tool => tool.name === name)!.run(args)
      await pause(400)
      after++
      await job.tools.find(tool => tool.name === 'file_read_package')!.run({})
      return { answer: '다시 읽어 보고 고쳤어요.' }
    })
    const result = await runToolSession({ engine, workdir: WORKDIR, tools: [...closingBuilds(tools, true), read] }, '신제품 소개 슬라이드 만들어줘')
    return { result, read, after }
  }

  it('the s18 D3 receipt tells the model not to read back (finding): the read-back was the model\'s own choice, and now it never gets a turn for it', async () => {
    const out = await deckTools().find(tool => tool.name === 'ppt_build')!.run({ slides: SLIDES }, { task: 'x' })
    expect(out).toContain('do not read it back or change it; answer now')
    expect(out).not.toMatch(/verify|read (it|the file) (back|again) (before|to)/i)
  })

  it('a deck with a Korean reply ends on that reply and the file, with no further model turn', async () => {
    const { result, read } = await run(deckTools(), { slides: SLIDES, reply: '신제품 소개 자료 3장으로 만들었어요.' })
    expect(result.answer).toBe('신제품 소개 자료 3장으로 만들었어요.\n\n[신제품 소개.pptx](engram-artifact:a1)')
    expect(result.steps.map(step => step.tool)).toEqual(['ppt_build'])
    expect(JSON.parse(result.steps[0]!.observation).markdownLink).toBe(receipt.markdownLink)
    expect(read.calls).toBe(0)
  })

  it('an English, long or technical reply gets the host line from the build instead', async () => {
    // Round 2 (r1 #4): two unasked English words in a Korean reply are English too; a Latin word the build itself holds (a title) is not.
    for (const reply of ['I made the product deck with three slides for you.', '세 장 만들었어요. 표지도 넣었어요. 일정도 넣었어요.', 'ppt_build로 만들었어요.', '자료를 만들었어요. Great work.', '발표 자료 완성! Enjoy']) {
      const { result } = await run(deckTools(), { slides: SLIDES, reply })
      expect(result.answer.split('\n')[0], String(reply)).toBe('신제품 소개, 3장으로 만들었어요.')
    }
  })

  it('a reply may name what the build holds in Latin letters', async () => {
    const slides = [{ title: 'Galaxy Buds 소개' }, { title: '특징', bullets: ['노이즈 캔슬링'] }]
    const { result } = await run(deckTools(), { slides, reply: 'Galaxy Buds 소개 자료 2장 만들었어요.' })
    expect(result.answer.split('\n')[0]).toBe('Galaxy Buds 소개 자료 2장 만들었어요.')
  })

  // Round 3 (r2 #1): a passed build closes by default; only an explicit `more` (another file still to come) keeps the turn open.
  it('a build marked more does not end the turn: the next file is made, and the last build closes with every file', async () => {
    const files = [{ artifact: 'p1', markdownLink: '[동아리 소개.pptx](engram-artifact:p1)' }, { artifact: 'w1', markdownLink: '[동아리 소개.docx](engram-artifact:w1)' }]
    const fake = (name: string, made: Record<string, unknown>): AgentTool => ({ name, description: name, argsSchema: { type: 'object', properties: {} }, run: async () => JSON.stringify(made) })
    let second = false
    const engine = brain(async job => {
      await job.tools.find(tool => tool.name === 'ppt_build')!.run({ slides: [{ title: '동아리 소개' }], more: true })
      await pause(400)
      await job.tools.find(tool => tool.name === 'word_write')!.run({ title: '동아리 소개', reply: '동아리 소개 발표 자료랑 문서 만들었어요.' })
      second = true
      await pause(400)
      return { answer: 'late' }
    })
    const result = await runToolSession({ engine, workdir: WORKDIR, tools: closingBuilds([fake('ppt_build', files[0]!), fake('word_write', files[1]!)], true) }, '동아리 소개 PPT랑 워드 둘 다 만들어줘')
    expect(second).toBe(true)
    expect(result.steps.map(step => step.tool)).toEqual(['ppt_build', 'word_write'])
    expect(result.answer.startsWith('동아리 소개 발표 자료랑 문서 만들었어요.')).toBe(true)
    for (const one of files) expect(result.answer).toContain(one.markdownLink)
  })

  it('a passed build with no reply and no more still ends the turn on the host line, nothing read back', async () => {
    for (const args of [{ slides: SLIDES }, { slides: SLIDES, reply: '' }, { slides: SLIDES, more: false }]) {
      const { result, read, after } = await run(deckTools(), args)
      expect(result.answer.split('\n')[0]).toBe('신제품 소개, 3장으로 만들었어요.')
      expect(read.calls).toBe(0)
      expect(after).toBe(0)
    }
  })

  // Round 3 (r2 #2): the host line and the reply only carry build text that is Korean itself; an English title the model chose stays out.
  it('an English title from the build never reaches a Korean line', async () => {
    const slides = [{ title: 'Quarterly Kickoff' }, { title: '팀 소개', bullets: ['새 멤버'] }]
    const { result } = await run(deckTools(), { slides, reply: 'Quarterly Kickoff 자료 2장 만들었어요.' })
    expect(result.answer.split('\n')[0]).toBe('발표 자료를 2장으로 만들었어요.')
    expect(builtLine('word_write', { title: 'Weekly Notes' }, true)).toBe('문서로 만들었어요.')
    expect(builtLine('file_create_workbook', { name: 'budget_2027.xlsx', sheets: [{}] }, true)).toBe('파일을 시트 1개로 만들었어요.')
    expect(builtLine('ppt_build', { slides: [{ title: 'Galaxy Buds 소개' }] }, true)).toBe('Galaxy Buds 소개, 1장으로 만들었어요.')
    expect(builtLine('ppt_build', { slides: [{ title: 'Quarterly Kickoff' }] }, false)).toBe('Made "Quarterly Kickoff", 1 slides.')
  })

  it('an audit refusal goes back to the model, which keeps working', async () => {
    const read = reader()
    const engine = brain(async job => {
      const said = await job.tools.find(tool => tool.name === 'ppt_build')!.run({ slides: [{ title: '신제품 소개' }, { title: '신제품 소개', bullets: ['TBD'] }], reply: '만들었어요.' })
      expect(said).toContain('nothing was built')
      await pause(300)
      return { answer: '다시 만들게요.' }
    })
    const result = await runToolSession({ engine, workdir: WORKDIR, tools: [...closingBuilds(deckTools(), true), read] }, 'x')
    expect(result.answer).toBe('다시 만들게요.')
  })

  it('a doc build and a sheet build close the same way, each with its host line when the reply is unusable', async () => {
    const fake = (name: string, link: string): AgentTool => ({ name, description: name, argsSchema: { type: 'object', properties: {} }, run: async args => { expect(args['reply']).toBeUndefined(); return JSON.stringify({ markdownLink: link }) } })
    const doc = await run([fake('word_write', '[동아리 회칙.docx](engram-artifact:d1)')], { title: '동아리 회칙', blocks: [{ kind: 'paragraph', text: '제1조' }], reply: 'Done.' }, 'word_write')
    expect(doc.result.answer).toBe('동아리 회칙 문서로 만들었어요.\n\n[동아리 회칙.docx](engram-artifact:d1)')
    expect(doc.read.calls).toBe(0)
    const sheet = await run([fake('file_create_workbook', '[가계부.xlsx](engram-artifact:s1)')], { name: '가계부.xlsx', sheets: [{ sheet: '11월', rows: [['a']] }, { sheet: '12월', rows: [['b']] }], reply: '가계부 엑셀 만들었어요.' }, 'file_create_workbook')
    expect(sheet.result.answer).toBe('가계부 엑셀 만들었어요.\n\n[가계부.xlsx](engram-artifact:s1)')
    expect(builtLine('file_create_workbook', { name: '가계부.xlsx', sheets: [{}, {}] }, true)).toBe('가계부 파일을 시트 2개로 만들었어요.')
    // Edits keep their path: they are never wrapped.
    const edit: AgentTool = { name: 'file_edit_package', description: 'edit', argsSchema: {}, run: async () => '{}' }
    expect(closingBuilds([edit], true)[0]).toBe(edit)
  })

  it('on the s18 D3 latencies (20.8 s to the build, a 1.0 s build) the turn ends within 1 s of the passed build', async () => {
    vi.useFakeTimers()
    try {
      const read = reader()
      let built = 0
      const engine = brain(async job => {
        await pause(20_760)
        await job.tools.find(tool => tool.name === 'ppt_build')!.run({ slides: SLIDES, reply: '신제품 소개 3장 만들었어요.' })
        built = Date.now()
        await pause(9_244)
        await job.tools.find(tool => tool.name === 'file_read_package')!.run({})
        await pause(15_934)
        return { answer: 'late' }
      })
      let ended = 0
      const turn = runToolSession({ engine, workdir: WORKDIR, tools: [...closingBuilds(deckTools(1_004), true), read] }, 'x').then(result => { ended = Date.now(); return result })
      await vi.advanceTimersByTimeAsync(23_000)
      const result = await turn
      expect(result.answer.startsWith('신제품 소개 3장 만들었어요.')).toBe(true)
      expect(ended - built).toBeLessThan(1000)
      expect(read.calls).toBe(0)
    } finally { vi.useRealTimers() }
  })
})
