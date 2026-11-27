import { expect, test } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runAgentLoop } from '../src/agent-loop.js'
import { runComet } from '../src/agent-session.js'
import { COLLEAGUE_CORE_RULE } from '../src/prompt.js'
import { handBacks, handedFrom, handoffBrief, partOutcome } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { deckChecked, officeTools } from '../src/office-tools.js'
import { MockEngine } from '../src/engine/mock.js'
import { engineCwd, type Engine, type EngineCwd, type ToolSessionJob, type ToolSessionResult } from '../src/engine/types.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

interface HandBack { reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
async function lead(ask: string, draft: string, handed?: string): Promise<{ answer: string; jobs: ToolSessionJob[]; got: string[] }> {
  const jobs: ToolSessionJob[] = [], got: string[] = []
  const assign: AgentTool = { name: 'assign', description: 'hands parts to teammates', argsSchema: { type: 'object' }, run: async () => handed ?? '' }
  const engine = {
    id: 'mock', detect: async () => ({ installed: true, loggedIn: true }),
    run: async function* () { yield { type: 'result', text: '' } },
    runTools: async (job: ToolSessionJob): Promise<ToolSessionResult> => {
      jobs.push(job)
      if (handed !== undefined) { const out = await job.tools.find(tool => tool.name === 'assign')!.run({ wait: true }); got.push(typeof out === 'string' ? out : out.text) }
      return { answer: draft }
    },
  } as unknown as Engine
  const result = await runComet({ engine, workdir: 'C:/tmp' as EngineCwd, tools: handed === undefined ? [] : [assign] }, ask, { guided: false })
  return { answer: result.answer, jobs, got }
}
async function stepped(ask: string, draft: string): Promise<{ answer: string; prompts: string[] }> {
  const prompts: string[] = []
  const engine = new MockEngine({ default: prompt => { prompts.push(prompt); return JSON.stringify({ tool: 'answer', args: { text: draft } }) } }, { gapMs: 0 })
  const result = await runComet({ engine, workdir: 'C:/tmp' as EngineCwd, tools: [] }, ask, { guided: false })
  return { answer: result.answer, prompts }
}
const back = (handed: string): HandBack => JSON.parse(handed) as HandBack

const MEETING = ['영업팀 11월 월간 회의를 주요 결정 위주로 정리했어요.', '', '주요 결정', '- 1월 신규 요금제 출시로 확정', '- 대리점 수수료는 동결', '- 지방 순회 설명회는 2월로 미룸', '', '미결', '- 판촉물 업체는 다음 주에 확정한다.'].join('\n')

test('a draft that leaves a part out gets no line spliced in: every line reaches the person byte-equal and in order', async () => {
  const { answer, jobs } = await lead('영업팀 회의록 결정이랑 담당자별 업무로 정리해줘', MEETING)
  expect(answer).toBe(MEETING)
  expect(answer.split('\n')).toEqual(MEETING.split('\n'))
  expect(answer).not.toContain('담당자별 업무')
  expect(jobs).toHaveLength(1)
})

test('no line of the draft is rewritten on the step path either: one model step, and its answer text is the reply', async () => {
  const { answer, prompts } = await stepped('영업팀 회의록 정리해줘', MEETING)
  expect(answer).toBe(MEETING)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/^JOB: COMET-STEP/m)
})

test('register: a copied 한다체 line stays as the model wrote it, and the turn that wrote it was told the -요 form', async () => {
  const { answer, jobs } = await lead('회의록 정리해줘', MEETING)
  expect(answer.split('\n').at(-1)).toBe('- 판촉물 업체는 다음 주에 확정한다.')
  expect(answer).toBe(MEETING)
  expect(jobs).toHaveLength(1)
  expect(jobs[0]!.system).toContain('Register: in Korean keep the polite-casual -요 form through the whole reply')
  expect(jobs[0]!.system).toContain('never switch to -습니다 or to 반말')
})

test('a sentence that claims more than was found is not taken out: the whole draft goes, and the rule against showing a part as finished is in the prompt', async () => {
  const draft = '세 곳 다 찾았어요. 울산은 성인 왕복 1만 5천 원이에요.\n포항은 1만 2천 원이에요.'
  const { answer, jobs } = await lead('케이블카 세 곳 삯 견줘줘', draft)
  expect(answer).toBe(draft)
  expect(jobs).toHaveLength(1)
  expect(jobs[0]!.system).toContain('A part still being worked on, or one that found nothing, is said in one plain sentence in its place, never left out and never shown as finished.')
})

test('nothing withholds the draft: with or without tools on the turn, and on either path, it is delivered as written', async () => {
  expect((await lead('a', '초안이에요.')).answer).toBe('초안이에요.')
  expect((await lead('a', '초안이에요.', handBacks([]))).answer).toBe('초안이에요.')
  expect((await stepped('a', '초안이에요.')).answer).toBe('초안이에요.')
})

const part = (id: string, role: string, brief: string, rest: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role, brief, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: '', ...rest })
const SOURCE = 'https://event.example.com/winter'
const FOUND = `성수동 겨울 마켓이 스무날에 열려요. — ${SOURCE}`
const minji = part('m1', '민지', '연말 이벤트 조사', { then: { botId: 'bot-m2', who: '하늘', brief: '이벤트 문구 2개' }, result: FOUND, sources: [SOURCE] })
const ITEMS = ['성수동에서 만나는 따뜻한 겨울', '12월 20일, 겨울 마켓으로 오세요']
const haneul = part('m2', '하늘', handoffBrief('이벤트 문구 2개', '민지', FOUND, '연말 이벤트 조사'), { lookup: undefined, writer: true, result: `1. ${ITEMS[0]}\n2. ${ITEMS[1]}` })
const OPENS_WITH_WORK = `하늘이 민지가 찾은 겨울 마켓으로 문구 두 개를 썼어요.\n\n1. ${ITEMS[0]}\n2. ${ITEMS[1]}`
const HANDOFF_ASK = '민지가 다 찾으면 하늘이 문구 두 개 쓰게 해줘'

test('a draft that opens on its lead before the items is shown as written, from the two hand-backs the lead model read', async () => {
  const handed = handBacks([minji, haneul])
  const { answer, jobs, got } = await lead(HANDOFF_ASK, OPENS_WITH_WORK, handed)
  expect(answer).toBe(OPENS_WITH_WORK)
  expect(got).toEqual([handed])
  expect(back(handed).reports.map(one => [one.who, one.result])).toEqual([['민지', FOUND], ['하늘', `1. ${ITEMS[0]}\n2. ${ITEMS[1]}`]])
  expect(back(handed).reports[0]!.sources).toEqual([SOURCE])
  expect(jobs).toHaveLength(1)
})

test('the lead sentence stays where the writer put it, before the items; no host template takes the draft\'s place', async () => {
  const { answer } = await lead(HANDOFF_ASK, OPENS_WITH_WORK, handBacks([minji, haneul]))
  expect(answer.split('\n')[0]).toBe('하늘이 민지가 찾은 겨울 마켓으로 문구 두 개를 썼어요.')
  expect(answer.indexOf('하늘이 민지가')).toBeLessThan(answer.indexOf(ITEMS[0]!))
  expect(answer.split('\n').slice(2)).toEqual([`1. ${ITEMS[0]}`, `2. ${ITEMS[1]}`])
})

test('a sentence the teammate never reported is not cut from the draft; the lead was handed only what the teammate said, and told not to cite what it did not read', async () => {
  const draft = `민지가 찾아보니 12월 20일 성수동 겨울 마켓이 열려요. [이벤트](${SOURCE}) 입장료는 1만 원이에요.`
  const solo = part('m1', '민지', '연말 이벤트 조사', { result: FOUND, sources: [SOURCE] })
  const { answer, jobs, got } = await lead('연말 이벤트 찾아줘', draft, handBacks([solo]))
  expect(answer).toBe(draft)
  expect(back(got[0]!).reports[0]!.result).toBe(FOUND)
  expect(got[0]).not.toContain('입장료')
  expect(jobs[0]!.system).toContain('no source line added for a fact you did not read this turn')
})

test('who it was made from travels in the second teammate\'s brief and in the hand-back note, so the lead can say it once', () => {
  const from = handedFrom(haneul.brief)!
  expect(from.from).toBe('민지')
  expect(from.job).toBe('연말 이벤트 조사')
  expect(from.result).toBe(FOUND)
  expect(from.brief).toBe('이벤트 문구 2개')
  const handed = back(handBacks([minji, haneul]))
  expect(handed.note).toContain('Where one agent handed their result to the next, the last result is the deliverable; keep the facts it took from the earlier one.')
  expect(handed.reports.map(one => one.who)).toEqual(['민지', '하늘'])
})

test('a draft of the items alone gets no made-from sentence added by a repair; the prompt is where telling it as a team is asked', async () => {
  const items = `1. ${ITEMS[0]}\n2. ${ITEMS[1]}`
  const { answer, jobs } = await lead(HANDOFF_ASK, items, handBacks([minji, haneul]))
  expect(answer).toBe(items)
  expect(jobs).toHaveLength(1)
  expect(jobs[0]!.system).toContain('Teammates\' work is told as a team would, who did what in one natural sentence')
})

const cable = (id: string, topic: string, text: string, url: string): TeamMember => part(id, `${topic}요금`, `${topic} 케이블카 요금`, { topic, result: `${text} ${url}`, sources: [url] })
test('three parts come back as three reports, each with its own words and its own address, and the note asks for a link after what it backs', () => {
  const members = [
    cable('h1', '울산', '요금: 대왕암공원 해상케이블카 일반 왕복 요금은 성인 기준 15,000원으로 책정되어 운영되고 있다', 'https://a.example/ulsan'),
    cable('h2', '포항', '요금: 12,000원', 'https://b.example/pohang'),
    cable('h3', '경주', '경주 케이블카는 성인 왕복 1만 원이에요.', 'https://c.example/gyeongju'),
  ]
  const handed = back(handBacks(members))
  expect(handed.reports).toHaveLength(3)
  expect(handed.reports.map(one => one.part)).toEqual(['울산', '포항', '경주'])
  expect(handed.reports.map(one => one.result)).toEqual(members.map(m => m.result))
  expect(handed.reports.map(one => one.sources)).toEqual([['https://a.example/ulsan'], ['https://b.example/pohang'], ['https://c.example/gyeongju']])
  expect(handed.note).toContain('each agent\'s source right after what it backs as a markdown link copied from sources or from their result, never a site name alone')
  expect(members.map(partOutcome)).toEqual(['found', 'found', 'found'])
})

test('r2: a table is the lead\'s to write only when asked for; a part with no words is handed back as it is and its table row is delivered as written', async () => {
  const pool = (id: string, topic: string, fee: string): TeamMember => part(id, topic, `${topic} 수영장 요금`, { topic, result: `자유수영 요금: ${fee} https://pool.example/${id}`, sources: [`https://pool.example/${id}`] })
  const none = part('d', '강서', '강서 수영장 요금', { topic: '강서', state: 'failed', result: 'Failed: it ended without an answer.', sources: ['https://pool.example/gangseo'] })
  const handed = handBacks([pool('a', '마포', '4,000원'), pool('b', '용산', '3,500원'), none])
  expect(back(handed).note).toContain('A table only when the person asked to compare or for a table.')
  expect(back(handed).reports[2]).toEqual({ who: '강서', part: '강서', state: 'failed', result: 'Failed: it ended without an answer.', sources: ['https://pool.example/gangseo'] })
  expect(partOutcome(none)).toBe('unfinished')
  const draft = '마포랑 용산은 찾았고 강서는 못 찾았어요.\n\n| | 자유수영 요금 |\n|---|---|\n| 마포 | 4,000원 [구청](https://pool.example/a) |\n| 용산 | 3,500원 [구청](https://pool.example/b) |\n| 강서 | 못 찾았어요 |'
  const { answer, jobs } = await lead('수영장 세 곳 자유수영 값 표로 보여줘', draft, handed)
  expect(answer).toBe(draft)
  expect(jobs).toHaveLength(1)
})

test('a table draft with dates in digits is delivered cell for cell; no host pass turns a date into other words', async () => {
  const draft = '세 태블릿 값과 나온 날이에요.\n\n| | 가격 | 출시일 |\n|---|---|---|\n| 태블릿 A | 89만 원 | 2026.03.02 |\n| 태블릿 B | 72만 원 | 2026.04.10 |\n| 태블릿 C | 65만 원 | 2027.01.15 |'
  const { answer, jobs } = await lead('태블릿 세 개 값과 나온 날 표로 줘', draft)
  expect(answer).toBe(draft)
  expect(answer).toContain('2026.03.02')
  expect(answer).not.toContain('3월 2일')
  expect(jobs).toHaveLength(1)
})

test('how a date and a figure are said is a rule for the writer; a draft with a dotted date reaches the person unchanged on the step path', async () => {
  const draft = '출시일은 2026.08.12.'
  expect((await stepped('출시일 알려줘', draft)).answer).toBe(draft)
  expect(COLLEAGUE_CORE_RULE).toContain('figures read as spoken (no ".0", dates in plain words).')
})

test('a deck build result lists what was checked: the slide count, every title and the audit result', () => {
  const line = deckChecked([{ title: '연간 채용 현황' }, { title: '분기별 입사자' }, { title: '내년 계획' }])
  expect(line).toContain('3 slides')
  expect(line).toContain('1. 연간 채용 현황 / 2. 분기별 입사자 / 3. 내년 계획')
  expect(line).toContain('passed')
  expect(line).toContain('do not read it back')
})

test('ppt_build and word_write: a built file returns the checked verdict in its receipt; a refused deck does not', async () => {
  const tools = officeTools({ run: async () => ({ markdownLink: '[채용.pptx](engram-artifact:x)' }) })
  const run = (name: string, args: Record<string, unknown>): Promise<string> => tools.find(one => one.name === name)!.run(args, { task: '' })
  const built = JSON.parse(await run('ppt_build', { slides: [{ title: '연간 채용 현황', subtitle: '인사팀' }, { title: '분기별 입사자', bullets: ['1분기: 수치 입력'] }] })) as { checked?: string }
  expect(built.checked).toContain('2 slides (1. 연간 채용 현황 / 2. 분기별 입사자)')
  expect(await run('ppt_build', { slides: [{ title: '[제목 입력]' }] })).not.toContain('Checked before it was built')
  const doc = JSON.parse(await run('word_write', { blocks: [{ kind: 'title', text: '채용 회고' }, { kind: 'paragraph', text: '올해 채용은 목표를 넘었어요.' }] })) as { checked?: string }
  expect(doc.checked).toContain('2 blocks')
})

test('r2: a draft with a plain-form line, a line more or an English sentence is delivered as it is; Korean lines are asked for in the prompt', async () => {
  const asked = '산악회 회의 정리해줘'
  for (const draft of ['산악회 회의는 목요일에 해요.\n산행 공지는 다음 달에 올린다.', '산악회 회의는 목요일에 해요.\n산행 공지는 다음 달에 올려요.\n산행 일정은 따로 정리해 둘게요.', '산악회 회의는 목요일에 해요.\nWe will post the hike notice next month.']) {
    const { answer, jobs } = await lead(asked, draft)
    expect(answer, draft).toBe(draft)
    expect(jobs, draft).toHaveLength(1)
    expect(jobs[0]!.system).toContain('In a Korean thread all is Korean but names, code, addresses, file names and text asked for in another language')
  }
})

test('r2: an English product name in a Korean draft is left alone, and so is everything else: no test of foreign words runs', async () => {
  const draft = 'Galaxy Tab S Ultra Max 가격이에요.\n\n할 일\n- 공지 발송'
  expect((await lead('태블릿 가격 알려줘', draft)).answer).toBe(draft)
  expect((await stepped('태블릿 가격 알려줘', draft)).answer).toBe(draft)
})

const library = (id: string, role: string, text: string, url: string): TeamMember => part(id, role, '도서관 운영시간 조사', { result: `${text} ${url}`, sources: [url] })
test('r2: a one-teammate draft that names nobody is shown as written, with no host attribution', async () => {
  const yuna = library('y', '유나', '주말에는 오후 5시까지 열어요.', 'https://lib.example/weekend')
  const draft = `주말에는 오후 5시까지 열어요. [도서관](https://lib.example/weekend)`
  const { answer, got } = await lead('유나가 도서관 토·일 여는 시간 봐 줬으면 해', draft, handBacks([yuna]))
  expect(answer).toBe('주말에는 오후 5시까지 열어요. [도서관](https://lib.example/weekend)')
  expect(back(got[0]!).reports).toEqual([{ who: '유나', state: 'done', result: yuna.result, sources: ['https://lib.example/weekend'] }])
})

test('r2: naming each teammate is asked for in the hand-back note; a merged draft that leaves one unnamed is delivered as it is', async () => {
  const yuna = library('y', '유나', '평일은 밤 9시까지예요.', 'https://lib.example/weekday'), taeo = library('t', '태오', '월요일은 쉬어요.', 'https://lib.example/closed')
  const text = '- 평일은 밤 9시까지예요. [도서관](https://lib.example/weekday)\n태오 말로는 월요일은 쉬어요. [도서관](https://lib.example/closed)'
  const { answer, jobs, got } = await lead('도서관 평일 시간은 유나, 쉬는 날은 태오가 봐줘', text, handBacks([yuna, taeo]))
  expect(answer).toBe(text)
  expect(answer).not.toContain('유나')
  expect(jobs).toHaveLength(1)
  expect(back(got[0]!).note).toContain('who did what in natural sentences that name each agent (never a line that starts with a name and a colon)')
  expect(back(got[0]!).reports.map(one => one.who)).toEqual(['유나', '태오'])
})

const garden = (id: string, role: string, text: string): TeamMember => part(id, role, '수목원 운영 조사', { result: `${text} https://garden.example/hours`, sources: ['https://garden.example/hours'] })
test('r3: two teammates citing one page are two reports with that page each, in the order given, and the draft is not rewritten', async () => {
  const draft = '정기 휴관일은 매주 화요일이에요. [수목원](https://garden.example/hours)\n야간 개장은 금요일 저녁 9시까지예요. [수목원](https://garden.example/hours)'
  const a = garden('a', '다온', '정기 휴관일은 매주 화요일이에요.'), b = garden('b', '시우', '야간 개장은 금요일 저녁 9시까지예요.')
  for (const order of [[a, b], [b, a]]) {
    const { answer, got } = await lead('수목원 휴관일은 다온, 야간 개장은 시우가 봐줘', draft, handBacks(order))
    expect(answer).toBe(draft)
    expect(back(got[0]!).reports.map(one => one.who)).toEqual(order.map(m => m.role))
    expect(back(got[0]!).reports.map(one => one.sources)).toEqual([['https://garden.example/hours'], ['https://garden.example/hours']])
  }
})

test('r3: a plain-form line is not turned into a quotation, taken out or shortened, whether or not it is all there is', async () => {
  const draft = '분기 예산 회의는 다음 주 수요일이에요.\n- 출장비 한도는 30만 원으로 낮춘다.\n- 비품 구매는 팀장이 승인해요.'
  const whole = await lead('예산 회의 요약해줘', draft)
  expect(whole.answer).toBe(draft)
  expect(whole.answer).not.toContain('라고 적혀 있어요')
  const alone = '출장비 한도는 30만 원으로 낮춘다.'
  expect((await lead('요약해줘', alone)).answer).toBe(alone)
  expect((await stepped('요약해줘', alone)).answer).toBe(alone)
  expect(whole.jobs).toHaveLength(1)
})

test('r3: items after a sentence about who made them stay where the writer put them; a draft already items-first is untouched too', async () => {
  const slogan = part('s2', '루아', '축제 슬로건 2개', { lookup: undefined, writer: true, result: '1. 가을밤, 강가에서 만나요\n2. 불빛 따라 걷는 축제' })
  const draft = '루아가 축제 슬로건을 두 개 뽑았어요.\n\n1. 가을밤, 강가에서 만나요\n2. 불빛 따라 걷는 축제\n\n마음에 드는 걸로 쓰시면 돼요.'
  const ready = '1. 가을밤, 강가에서 만나요\n2. 불빛 따라 걷는 축제\n\n루아가 뽑았어요.'
  for (const text of [draft, ready]) {
    const { answer, jobs, got } = await lead('루아한테 축제 슬로건 두 개 뽑게 해', text, handBacks([slogan]))
    expect(answer).toBe(text)
    expect(jobs).toHaveLength(1)
    expect(back(got[0]!).reports[0]!.result).toBe(slogan.result)
  }
})

test('r3 D3: a deck built clean is answered with no read-back asked by the host, and the build verdict is in what the model reads next', async () => {
  const tools = officeTools({ run: async () => ({ artifact: 'a1', path: '/out/분기 실적.pptx', markdownLink: '[분기 실적.pptx](engram-artifact:a1)', completeReadback: true }) })
  const read = { name: 'file_read_package', description: 'reads a package', argsSchema: { type: 'object' }, calls: 0, run: async () => { read.calls++; return '{}' } }
  const prompts: string[] = []
  let call = 0
  const engine = new MockEngine({
    'COMET-STEP': prompt => {
      prompts.push(prompt)
      return ++call === 1
        ? JSON.stringify({ tool: 'ppt_build', args: { slides: [{ title: '분기 실적', subtitle: '영업팀' }, { title: '지역별 매출', bullets: ['수도권: 수치 입력'] }] } })
        : JSON.stringify({ tool: 'answer', args: { text: '두 장으로 만들었어요. [분기 실적.pptx](engram-artifact:a1)' } })
    },
  })
  const paths = await initVault(await tmpVaultRoot('c18b-d3'), { git: false })
  const result = await runAgentLoop({ engine, workdir: engineCwd(paths), tools: [...tools, read] }, '분기 실적 PPT 두 장 만들어줘', { guided: false })
  expect(result.incomplete).toBeUndefined()
  expect(result.steps.map(step => step.tool)).toEqual(['ppt_build'])
  expect(read.calls).toBe(0)
  expect(call).toBe(2)
  expect(prompts[1]).toContain('Checked before it was built and passed: 2 slides (1. 분기 실적 / 2. 지역별 매출)')
  expect(prompts[1]).toContain('its receipt is that readback')
})
