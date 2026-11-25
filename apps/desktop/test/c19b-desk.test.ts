import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { officeTools, runToolSession, type AgentLoopOptions, type AgentTool, type Engine, type EngineCwd, type ToolSessionJob, type ToolSessionResult } from 'core'
import * as deskLane from '../src/main/desk-lane.js'
const DESK_FUNCTIONS = ['fixSlideTitle', 'keepAsk', 'keptFix', 'kindSortAsk', 'plainKeep', 'slideTitleFix', 'sortByKind']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()

async function turn(draft: string, said: string, options: AgentLoopOptions = {}, wait = 0) {
  const jobs: ToolSessionJob[] = [], voiced: string[] = []
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); if (wait) await new Promise(resolve => setTimeout(resolve, wait)); return { answer: draft } }, quick: async (prompt: string) => { voiced.push(prompt); return '{"problems":[]}' } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: '/tmp/c19b-desk' as EngineCwd, tools: [] }, said, options)
  return { posted: result.answer, calls: jobs.length, voiced, told: jobs.map(job => `${job.system}\n${job.prompt}\n${job.opening ?? ''}`).join('\n') }
}
const KEEPS = 'write that reply again in the asked form with every fact and every constraint of the original ask kept, and nothing about what you changed'

describe('item 1: a desk answer\'s ```replies block is not prose', () => {
  const REPLIES = ['```replies', '두부도 넣어줘', '양 좀 줄여줘', '```'].join('\n')
  const SOURCE = '장보기: 대파 한 단, 계란 한 판, 우유 1L, 두부'
  const DRAFT = ['장보기 목록만 뽑았어요.', '', '- 대파 한 단', '- 계란 한 판', '- 우유 1L', '', REPLIES].join('\n')
  it('the block reaches the person byte-identical with the answer around it: no step reads it as prose or takes a line of it', async () => {
    const { posted, voiced, told } = await turn(DRAFT, '장보기 목록만 뽑아줘')
    expect(told).not.toContain(SOURCE)
    expect(posted).toBe(DRAFT)
    expect(posted.endsWith(REPLIES)).toBe(true)
    expect(posted.split('\n').filter(line => line.startsWith('```'))).toEqual(['```replies', '```'])
    expect(voiced).toEqual([])
  })
  it('nothing is added above or after the trailing block: a part the model left out stays out', async () => {
    const { posted } = await turn(DRAFT, '장보기 목록이랑 같이 살 것 뽑아줘')
    expect(posted.endsWith(`- 우유 1L\n\n${REPLIES}`)).toBe(true)
    expect(posted).not.toContain('두부\n')
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
  })
})

describe('item 2: a line is under one part because the model is told so, not because a repair is refused', () => {
  const SOURCE = ['# 하반기 워크숍 회의록', '', '## 결정', '- 워크숍 장소는 양평 연수원으로 확정', '- 1박 2일 일정으로 진행', '',
    '## 업무', '- 숙소 예약 — 윤서아, 11월 25일', '- 버스 대절 견적 — 마도윤, 11월 27일', '- 프로그램 초안 — 강예린, 12월 1일'].join('\n')
  const ASK = '워크숍 회의록에서 결정이랑 담당 업무 나눠서 정리해줘'
  const DRAFT = ['워크숍 회의 정리했어요.', '', '결정', '- 워크숍 장소는 양평 연수원으로 확정', '- 1박 2일 일정으로 진행', '- 숙소 예약 — 윤서아, 11월 25일', '- 버스 대절 견적 — 마도윤, 11월 27일', '- 프로그램 초안 — 강예린, 12월 1일'].join('\n')
  const TASKS = ['- 숙소 예약 — 윤서아, 11월 25일', '- 버스 대절 견적 — 마도윤, 11월 27일', '- 프로그램 초안 — 강예린, 12월 1일']
  const reworded = ['- 윤서아 님이 숙소 예약을 11월 25일까지 해요', '- 마도윤 님이 버스 대절 견적을 11월 27일까지 받아요', '- 강예린 님이 프로그램 초안을 12월 1일까지 써요']
  it('the turn says an item is listed once and carries no copy of the notes, and the draft is posted with every task line once, where the model put it', async () => {
    const { posted, told, calls, voiced } = await turn(DRAFT, ASK)
    expect(told).not.toContain(SOURCE)
    expect(told).toContain('A decision or item is listed once, never again under a second heading.')
    expect(posted).toBe(DRAFT)
    expect(posted).not.toContain('님이')
    for (const task of TASKS) expect(posted.split('\n').filter(line => line === task)).toHaveLength(1)
    expect(calls).toBe(1)
    expect(voiced).toEqual([])
  })
  it('the host tells no copy from a different line: a reworded copy the model wrote is posted beside the first', async () => {
    const twice = [...TASKS, ...reworded].join('\n')
    expect((await turn(twice, ASK)).posted).toBe(twice)
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
  })
})

describe('item 3: a shorter reshape is the model\'s own reply: one call, the ask in view, nothing rewritten after', () => {
  const ASK = '택배 늦어서 미안하다는 문자 한 줄 써줘'
  const LAST = '고객님, 택배 배송이 늦어져서 정말 죄송합니다. 최대한 빨리 받아보실 수 있도록 하겠습니다.'
  const thread = (ask: string, last: string): AgentLoopOptions => ({ history: [{ role: 'user', text: ask }, { role: 'assistant', text: last }] })
  it('a shorter draft goes out after one model call and no voice call; the original is never put back', async () => {
    const short = '택배가 늦어져 죄송합니다. 곧 받아보시게 할게요.'
    const { posted, calls, voiced } = await turn(short, '좀 더 줄여줘', thread(ASK, LAST))
    expect(posted).toBe(short)
    expect(posted).not.toBe(LAST)
    expect(calls).toBe(1)
    expect(voiced).toEqual([])
  })
  it('the ask\'s audience is in front of the model with the rule to keep it; a draft that drops it is posted as written (not a harness wording)', async () => {
    const ask = '할머니께 보낼 생신 축하 문자 존댓말로 써줘', last = '할머니, 생신 진심으로 축하드려요. 늘 건강하시고 오래오래 저희 곁에 계셔 주세요. 사랑해요.'
    const casual = '할머니 생일 축하해! 건강해.'
    const { posted, told } = await turn(casual, '더 짧게 해줘', thread(ask, last))
    expect(told).toContain('존댓말로')
    expect(told).toContain(KEEPS)
    expect(posted).toBe(casual)
  })
  it('on the Q4 latency (a 1.7 s draft) the reshape ends when the draft does, with 1 call', async () => {
    vi.useFakeTimers()
    try {
      const began = Date.now(), out = turn('배송 늦어 죄송해요.', '좀 더 줄여줘', thread(ASK, LAST), 1700)
      await vi.advanceTimersByTimeAsync(1700)
      const { posted, calls, voiced } = await out
      expect(posted).toBe('배송 늦어 죄송해요.')
      expect(Date.now() - began).toBeLessThan(2000)
      expect(calls).toBe(1)
      expect(voiced).toEqual([])
    } finally { vi.useRealTimers() }
  })
  it('a draft that was not shorter is posted too: the host measures no length', async () => {
    const longer = `${LAST} 감사합니다.`
    expect((await turn(longer, '좀 더 줄여줘', thread(ASK, LAST))).posted).toBe(longer)
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
  })
  it('another form is asked of the model the same way, and its reply is posted, never the last reply again', async () => {
    const polite = '택배 배송이 늦어져 정말 죄송해요. 최대한 빨리 받아보시게 할게요.'
    const { posted, told, voiced } = await turn(polite, '좀 부드럽게', thread(ASK, LAST))
    expect(told).toContain('(shorter, as a table, another tone or language)')
    expect(told).toContain(LAST)
    expect(posted).toBe(polite)
    expect(voiced).toEqual([])
  })
})

describe('item 4: a build the host audit passed hands back to the model, whose reply is posted as written', () => {
  const WORKDIR = '/Users/kwon-yunjae/engram-orch/tmp/c19b' as EngineCwd
  const brain = (script: (job: ToolSessionJob) => Promise<ToolSessionResult>): Engine => ({ id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: script }) as unknown as Engine
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const receipt = { artifact: 'a1', path: '/out/신제품 소개.pptx', markdownLink: '[신제품 소개.pptx](engram-artifact:a1)', completeReadback: true }
  const deckTools = () => officeTools({ run: async () => receipt })
  const SLIDES = [{ title: '신제품 소개', subtitle: '마케팅팀' }, { title: '핵심 기능', bullets: ['한 번 충전으로 3일 사용', '방수 등급 IP68'] }, { title: '출시 일정', bullets: ['12월 첫 주 사전 예약'] }]
  const reader = () => { const read = { name: 'file_read_package', description: 'reads a package', argsSchema: { type: 'object' }, calls: 0, run: async () => { read.calls++; return '{}' } }; return read }
  const run = async (tools: AgentTool[], args: Record<string, unknown>, reply: string, name = 'ppt_build', readBack = false) => {
    const read = reader()
    let after = 0
    const engine = brain(async job => {
      await job.tools.find(tool => tool.name === name)!.run(args, { task: 'x' })
      await pause(50)
      after++
      if (readBack) await job.tools.find(tool => tool.name === 'file_read_package')!.run({}, { task: 'x' })
      return { answer: reply }
    })
    const result = await runToolSession({ engine, workdir: WORKDIR, tools: [...tools, read] }, '신제품 소개 슬라이드 만들어줘')
    return { result, read, after }
  }

  it('the s18 D3 receipt tells the model not to read back (finding): the read-back was the model\'s own choice, and now it never gets a turn for it', async () => {
    const out = await deckTools().find(tool => tool.name === 'ppt_build')!.run({ slides: SLIDES }, { task: 'x' })
    expect(out).toContain('do not read it back or change it; answer now')
    expect(out).not.toMatch(/verify|read (it|the file) (back|again) (before|to)/i)
  })

  it('a deck build does not end the turn: the Korean reply the model writes after it is posted exactly as written, with the file as its card', async () => {
    const { result, read, after } = await run(deckTools(), { slides: SLIDES }, '신제품 소개 자료 3장으로 만들었어요.')
    expect(after).toBe(1)
    expect(result.answer).toBe('신제품 소개 자료 3장으로 만들었어요.')
    expect(result.files).toEqual([{ name: '신제품 소개.pptx', href: 'a1' }])
    expect(result.steps.map(step => step.tool)).toEqual(['ppt_build'])
    expect(JSON.parse(result.steps[0]!.observation).markdownLink).toBe(receipt.markdownLink)
    expect(read.calls).toBe(0)
  })

  it('an English, long, technical or Latin-lettered reply after a build is posted as written too: the host has no line of its own to put there', async () => {
    for (const reply of ['I made the product deck with three slides for you.', '세 장 만들었어요. 표지도 넣었어요. 일정도 넣었어요.', 'ppt_build로 만들었어요.', '자료를 만들었어요. Great work.', '발표 자료 완성! Enjoy', 'Galaxy Buds 소개 자료 2장 만들었어요.']) {
      const { result } = await run(deckTools(), { slides: SLIDES }, reply)
      expect(result.answer, String(reply)).toBe(reply)
    }
  })

  it('two builds in one turn both run, and the one reply the model writes after them is posted with a card for every file', async () => {
    const files = [{ artifact: 'p1', markdownLink: '[동아리 소개.pptx](engram-artifact:p1)', completeReadback: true }, { artifact: 'w1', markdownLink: '[동아리 소개.docx](engram-artifact:w1)', completeReadback: true }]
    const fake = (name: string, made: Record<string, unknown>): AgentTool => ({ name, description: name, argsSchema: { type: 'object', properties: {} }, run: async () => JSON.stringify(made) })
    const engine = brain(async job => {
      await job.tools.find(tool => tool.name === 'ppt_build')!.run({ slides: [{ title: '동아리 소개' }] }, { task: 'x' })
      await job.tools.find(tool => tool.name === 'word_write')!.run({ title: '동아리 소개' }, { task: 'x' })
      return { answer: '동아리 소개 발표 자료랑 문서 만들었어요.' }
    })
    const result = await runToolSession({ engine, workdir: WORKDIR, tools: [fake('ppt_build', files[0]!), fake('word_write', files[1]!)] }, '동아리 소개 PPT랑 워드 둘 다 만들어줘')
    expect(result.steps.map(step => step.tool)).toEqual(['ppt_build', 'word_write'])
    expect(result.answer).toBe('동아리 소개 발표 자료랑 문서 만들었어요.')
    expect(result.files).toEqual([{ name: '동아리 소개.pptx', href: 'p1' }, { name: '동아리 소개.docx', href: 'w1' }])
  })

  it('a passed build never closes the turn: a read-back the model chooses runs, and the answer it writes in its next step is posted', async () => {
    const { result, read, after } = await run(deckTools(), { slides: SLIDES }, '다시 읽어 보고 고쳤어요.', 'ppt_build', true)
    expect(result.answer).toBe('다시 읽어 보고 고쳤어요.')
    expect(result.files).toEqual([{ name: '신제품 소개.pptx', href: 'a1' }])
    expect(after).toBe(1)
    expect(read.calls).toBe(1)
  })

  it('an English title in the model\'s reply reaches the person as the model wrote it; the build asks for no reply of its own', async () => {
    const slides = [{ title: 'Quarterly Kickoff' }, { title: '팀 소개', bullets: ['새 멤버'] }]
    const { result } = await run(deckTools(), { slides }, 'Quarterly Kickoff 자료 2장 만들었어요.')
    expect(result.answer).toBe('Quarterly Kickoff 자료 2장 만들었어요.')
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
    const schema = deckTools().find(tool => tool.name === 'ppt_build')!.argsSchema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties)).not.toContain('reply')
    expect(Object.keys(schema.properties)).not.toContain('more')
  })

  it('an audit refusal goes back to the model, which keeps working', async () => {
    const read = reader()
    const engine = brain(async job => {
      const said = await job.tools.find(tool => tool.name === 'ppt_build')!.run({ slides: [{ title: '신제품 소개' }, { title: '신제품 소개', bullets: ['TBD'] }] }, { task: 'x' })
      expect(said).toContain('nothing was built')
      await pause(300)
      return { answer: '다시 만들게요.' }
    })
    const result = await runToolSession({ engine, workdir: WORKDIR, tools: [...deckTools(), read] }, 'x')
    expect(result.answer).toBe('다시 만들게요.')
  })

  it('a doc build and a sheet build hand back the same way, each posted on the reply the model gave', async () => {
    const fake = (name: string, link: string): AgentTool => ({ name, description: name, argsSchema: { type: 'object', properties: {} }, run: async args => { expect(args['reply']).toBeUndefined(); return JSON.stringify({ artifact: link.slice(link.lastIndexOf(':') + 1, -1), markdownLink: link, completeReadback: true }) } })
    const doc = await run([fake('word_write', '[동아리 회칙.docx](engram-artifact:d1)')], { title: '동아리 회칙', blocks: [{ kind: 'paragraph', text: '제1조' }] }, 'Done.', 'word_write')
    expect(doc.result.answer).toBe('Done.')
    expect(doc.result.files).toEqual([{ name: '동아리 회칙.docx', href: 'd1' }])
    expect(doc.read.calls).toBe(0)
    const sheet = await run([fake('file_create_workbook', '[가계부.xlsx](engram-artifact:s1)')], { name: '가계부.xlsx', sheets: [{ sheet: '11월', rows: [['a']] }, { sheet: '12월', rows: [['b']] }] }, '가계부 엑셀 만들었어요.', 'file_create_workbook')
    expect(sheet.result.answer).toBe('가계부 엑셀 만들었어요.')
    expect(sheet.result.files).toEqual([{ name: '가계부.xlsx', href: 's1' }])
  })
})
