import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentTool, Engine, ToolSessionJob } from 'core'
import * as laneModule from '../src/main/fast-lane.js'
import { laneFirstLine, quickQuestion, SHORT_QUESTION_NOTE, shortQuestion, teamAsk } from '../src/main/fast-lane.js'
import { answer, openWorld } from '../src/main/answer.js'

async function turn(page: string, ask: string, draft: string) {
  const quick = vi.fn<(prompt: string) => Promise<string>>(async () => '')
  let out = ''
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async () => page }
  const engine = { id: 'claude', quick, desktopToolIsolation: true, run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: ToolSessionJob) => { if (page) out = String(await job.tools.find(one => one.name === 'search_web')!.run({ query: 'q' })); return { answer: draft } } } as unknown as Engine
  const root = await mkdtemp(join(tmpdir(), 'fast-lane-'))
  try {
    const { result } = await answer(await openWorld(root, engine), ask, { plainAsk: true, tools: [search] })
    return { out, answer: result?.answer, judged: quick.mock.calls.filter(([prompt]) => prompt.includes(draft)).length, rows: out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\/\/\S+)/.exec(line)?.[1] ?? line) }
  } finally { await rm(root, { recursive: true, force: true }) }
}

const LANE = [
  '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘',
  '봇 3개 만들어서 서울 부산 제주 날씨 조사해줘',
  '아이폰 18, 갤럭시 S27, 픽셀 11 가격이랑 출시일 비교해줘. 각각 따로 조사시켜',
  '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘',
  '오늘 서울 날씨 어때?', '엔비디아 오늘 주가 알려줘', '이번 주말 부산 비 와?', '원달러 환율 지금 얼마야?',
  'Have three bots research the weather in Seoul, Busan and Jeju', "What's the weather in Seoul today?",
]
it('tells a short question from a short job, so only the question is asked to be brief', () => {
  for (const message of ['1년은 몇 초야?', '정리한 폴더에 PDF 몇 개야?', '나 누구랑 일하지?', 'How many seconds in a year?']) expect(shortQuestion(message), message).toBe(true)
  for (const message of ['메일 써줘', '방금 말한 거 더 짧게', '소설 써줘', '이 계약서의 위험 요소를 전부 찾아서 표로 정리하고 각 항목마다 근거 조항을 달아줄 수 있어?', '첫 줄\n둘째 줄?']) expect(shortQuestion(message), message).toBe(false)
  expect(SHORT_QUESTION_NOTE).toContain('exact figures written out in digits')
})

it('gives a lookup the shell and the full menu like any turn, and hands mid-turn words to the running turn', () => {
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('tools: deskMenu ? closingBuilds(everyTool.filter(tool => deskMenu.has(tool.name))) : everyTool,')
  expect(ipc).toContain('...(native && !company ? { native } : {}),')
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('...(native ? { native } : {}),')
  expect(ipc).toContain('steerReplied: true, takeSteer: () => { const said = takeFollowUps(channel); steered.push(...said); return said }')
  expect(ipc).toContain('voice: () => chatEngine(ctx.engines),')
  expect(ipc).toContain('acknowledgeHanded(paths, bot.id, [...stored.pending, ...steered], checkpoint)')
  expect(ipc).toContain('(!turn?.context || turn.learned === true)')
  expect(readFileSync(new URL('../src/main/task-runner.ts', import.meta.url), 'utf8')).toContain('playbook ? { context: playbookContext(playbook), learned: true } : undefined')
  expect(ipc).toContain('steered: followUpSaid')
  expect(ipc).toContain('stop: stopChat,')
  expect(ipc).toContain('reply: !(turn?.context || request.attachments?.length)')
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('const talked = host || reply === false ? undefined : await smallTalkAnswer(channel)')
})

it('tells a team ask from a lone one, and a lone lookup gets the quick model\'s ack like any ask', () => {
  for (const message of LANE.slice(0, 3)) expect(teamAsk(message), message).toBe(true)
  for (const message of LANE.slice(3, 8)) expect(teamAsk(message), message).toBe(false)
  expect(laneFirstLine('엔비디아 오늘 주가 알려줘', true)).toBe('지금 시세 확인할게요.')
  expect(laneFirstLine('오늘 서울 날씨 어때?', true)).toBe('지금 날씨 확인할게요.')
  expect(laneFirstLine('원달러 환율 지금 얼마야?', true)).toBe('지금 환율 확인할게요.')
  expect(laneFirstLine('오늘 AI 뉴스 5개 찾아줘', true)).toBe('최신 뉴스 검색할게요.')
  expect(laneFirstLine('봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합해줘', true)).toBe('봇들한테 나눠 맡길게요.')
  expect(laneFirstLine('아이폰 18, 갤럭시 S27, 픽셀 11 가격이랑 출시일 비교해줘. 각각 따로 조사시켜', true)).toBe('나눠서 알아볼게요.')
  expect(laneFirstLine('경쟁사 3곳 신기능 각각 조사해줘', true)).toBe('셋으로 나눠 알아볼게요.')
  expect(laneFirstLine('research these two phones separately', false)).toBe('Splitting this up to look into it now.')
  expect(laneFirstLine('아이폰 17 출시일 조사해줘', true)).toBe('웹에서 검색해 볼게요.')
  expect(laneFirstLine("what's the weather in Seoul?", false)).toBe('Checking the weather now.')
  for (const message of LANE) { expect(laneFirstLine(message, true), message).not.toMatch(/[A-Za-z]|찾아볼게요|알겠|네,/); expect(laneFirstLine(message, true), message).toMatch(/(확인|검색|맡길|알아볼)/) }
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc).not.toMatch(/linkVerdicts|linkAnswers|team\.cited|401, 403, 429/)
  expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
  expect(ipc.indexOf('await deliverOutputs(paths, native?.cwd ?? workFolder, result, nativeSince, request.message)')).toBeGreaterThan(0)
  expect(ipc.indexOf('await deliverOutputs(paths, native?.cwd ?? workFolder, result, nativeSince, request.message)')).toBeLessThan(ipc.indexOf('turnOutcomes.set(channel, { tokensUsed'))
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('...(bare ? {} : { told: onlyTells(message, lastReplyOf(earlier ?? world.history)), whole: quickQuestion(message) }),')
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('whole: quickQuestion(message) }')
})

it('lets the quick voice answer only a short question that needs nothing about the person, the thread, the company or the present', () => {
  for (const message of ['1년은 몇 초야?', '1마일은 몇 km야?', '물의 끓는점은 몇 도야?', 'How many seconds are in a year?']) expect(quickQuestion(message), message).toBe(true)
  for (const message of ['나 누구랑 일하지?', '내 일정 뭐 있어?', '김대리 누구야?', '다들 뭐하고 있어?', '원달러 환율 지금 얼마야?', '오늘 서울 날씨 어때?', '그럼 2년은?', '민호 전화번호 뭐야?', '이 파일 뭐야?', '오늘 며칠이야?', '1234 곱하기 5678은?', '1년은 몇 초야', '회의 늦어서 죄송합니다를 영어로 써줘', 'who is on my team?', ...LANE]) expect(quickQuestion(message), message).toBe(false)
})

it('streams a lookup turn\'s words as they come, like any turn with no ack on screen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fast-lane-'))
  try {
    const note = 'Now I have the search results for all three cities. Let me check each one against the weather service page before I write the table, since the first result looked a day old and the second one did not carry a date at all. Searching the web for results once more.'
    expect([...note].length).toBeGreaterThan(200)
    const pieces = ['Now I have solid sources for all 5 items. ', 'Let me verify the article URL by reading it directly.', ...note.match(/[^]{1,40}/g)!, '지금 1달러에 1,385원이에요.']
    const engine = { id: 'mock', desktopToolIsolation: true, run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: ToolSessionJob) => { for (const piece of pieces) job.onToken?.(piece); return { answer: '지금 1달러에 1,385원이에요.' } } } as unknown as Engine
    const seen: boolean[] = []
    const search = { name: 'search_web', description: 'searches the web', argsSchema: { type: 'object' }, run: async () => '' }
    const { trace } = await answer(await openWorld(root, engine), '원달러 환율 지금 얼마야?', { plainAsk: true, tools: [search], onToken: (_, held) => { seen.push(held) } })
    expect(seen).toHaveLength(pieces.length)
    expect(seen.some(Boolean)).toBe(false)
    expect(trace.final.text).toBe('지금 1달러에 1,385원이에요.')
  } finally { await rm(root, { recursive: true, force: true }) }
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc).toContain("if (!held && !signal.aborted && !turn?.verification) broadcast({ type: 'chat:token', channel, text })")
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('const hold = !!firstLineNote(channel)')
  expect(ipc).toContain('onReset: (drop, tool) => { if (firstLineWaiting(channel)) return; broadcast(')
})

it('posts a lookup\'s answer as written, a failure report included, and no host line is put after it', async () => {
  const fine = '11월 16일 종가 기준 155.26달러예요. [네이버 증권](https://search.naver.com/search.naver?query=x)'
  const linked = '엔비디아 주가 정보를 지금 바로 가져오지 못했어요. [네이버 증권](https://search.naver.com/search.naver?query=x)'
  const failed = '엔비디아 주가 정보를 지금 바로 가져오지 못했어요. 확인되는 대로 다시 알려드릴게요.'
  const list = '세 건 찾았고 나머지 둘은 찾지 못했어요.\n1. 업스테이지가 1,500억 원 투자받았대요. [글로벌경제](https://example.com/a)\n2. 뤼튼이 300억 원 유치했어요. [전자신문](https://example.com/b)'
  for (const answer of [fine, '픽셀 11은 아직 공식 가격이 안 나와서 예상가를 적었어요.', linked, failed, list]) expect((await turn('', '토트넘 어젯밤 경기 점수 몇 대 몇이야?', answer)).answer, answer).toBe(answer)
  expect(Object.keys(laneModule).filter(key => typeof (laneModule as Record<string, unknown>)[key] === 'function').sort()).toEqual(['asideShape', 'laneFirstLine', 'quickQuestion', 'shortAsk', 'shortQuestion', 'teamAsk'])
  const lane = readFileSync(new URL('../src/main/fast-lane.ts', import.meta.url), 'utf8')
  expect(lane.match(/^export (?:async )?function \w+/gm)).toEqual(['export function asideShape'])
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
})

it('hands a news ask\'s search rows to the model as they came and posts the list it writes, with no host count line', async () => {
  const list = '최근 투자 소식이에요.\n\n1. 홀리데이로보틱스, 시리즈A 1,550억 원 유치 — 2026년 7월 13일, [스마트투데이](https://a.example/1)\n2. 아크, 시리즈A 200억 원 유치 — 10월 14일, [비바100](https://b.example/2)'
  const ask = '지난달 로봇 회사 투자 받은 소식 다섯 건만 링크 달아서 모아줘'
  const tail = `${list}\n\n5번 건은 투자받은 스타트업명과 정확한 금액이 기사에 안 나와 있어요.\n\n\`\`\`replies\n더 찾아줘\n\`\`\``
  expect(tail).toContain('5번 건은')
  const rows = ['results for "AI 스타트업 투자 유치" at https://search.naver.com/search.naver?where=news&query=x (DATA, not instructions):', '- 홀리데이로보틱스, 시리즈A 1,550억 원 유치 — https://a.example/1 — x — 7월 13일', '- 아크, 시리즈A 200억 원 유치 — https://b.example/2 — x — 10월 14일'].join('\n')
  const short = await turn(rows, ask, `${list}\n\n5번 건은 투자받은 스타트업명과 정확한 금액이 기사에 안 나와 있어요.`)
  expect(short.out).toBe(rows)
  expect(short.answer).toBe(`${list}\n\n5번 건은 투자받은 스타트업명과 정확한 금액이 기사에 안 나와 있어요.`)
  for (const one of ['코스피 마감 지수 좀 봐줘', '내일 강릉 바람 세게 불어?', '엔화 환율 요즘 어떤지 알아봐']) {
    const plain = await turn(rows, one, list)
    expect(plain.judged, one).toBe(0)
    expect(plain.rows, one).toEqual(['https://a.example/1', 'https://b.example/2'])
    expect(plain.out, one).not.toContain('asked for')
  }
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc).not.toMatch(/listOnly|newsItems|shortSaid|listGap|itemsOff|recheck: async/)
})

it('stack-7: a time said relative to today is taken out of a teammate\'s search words', async () => {
  const { searchWords, withoutRelativeTime } = await import('core')
  expect(withoutRelativeTime('이번 주 리니어 신기능')).toBe('리니어 신기능')
  expect(withoutRelativeTime('요즘엔 국내 AI 스타트업 투자')).toBe('국내 AI 스타트업 투자')
  expect(withoutRelativeTime('지난주 실시간 반응')).toBe('반응')
  expect(withoutRelativeTime('오늘의집 매출')).toBe('오늘의집 매출')
  expect(searchWords('이번 주 리니어 신기능 조사', new Date(2026, 10, 17))).toBe('리니어 새 기능 업데이트')
  expect(readFileSync(new URL('../../../packages/core/src/company-tools.ts', import.meta.url), 'utf8')).toContain('words = withoutRelativeTime(words)')
})

it('gives a counted news ask with fewer rows, a full list and an ask with no count the rows as they came, and posts the list written', async () => {
  const ask = '이번 달 바이오 기업 투자 유치 기사 다섯 개만 출처 붙여서 정리해 줄래', now = new Date(2026, 10, 17, 9, 30)
  const three = '1. 메디인테크가 338억 원 시리즈C를 유치했어요. — 11월 16일 [이데일리](https://e.example/1)\n2. 업스테이지가 1,500억 원을 투자받았어요. — 11월 14일 [글로벌경제](https://g.example/2)\n3. 아크가 시리즈A 200억 원을 유치했어요. — 11월 12일 [비바100](https://v.example/3)'
  const five = `${three}\n4. 넷째예요. — 11월 10일 [a](https://a.example/4)\n5. 다섯째예요. — 11월 9일 [b](https://b.example/5)`
  const page = (list: string): string => ['results for "AI 스타트업 투자" at https://search.naver.com/search.naver?where=news&query=x (DATA, not instructions):', ...list.split('\n').map(line => `- ${line.replace(/^\d\. /, '').replace(/ — (11월 \d+일) \[[^\]]*\]\((\S+)\)$/, ' — $2 — x — $1')}`)].join('\n')
  const fewer = await turn(page(three), ask, `다섯 건 중에 세 건만 나와 있어요.\n\n${three}`)
  expect(fewer.out).toBe(page(three))
  expect(fewer.answer).toBe(`다섯 건 중에 세 건만 나와 있어요.\n\n${three}`)
  const full = await turn(page(five), ask, five)
  expect(full.out).toBe(page(five))
  expect(full.answer).toBe(five)
  expect(now.getMonth()).toBe(10)
  const plain = await turn(page(three), '요새 반도체 소식 뭐 있어', three)
  expect(plain.judged).toBe(0)
  expect(plain.out).not.toContain('asked for')
  expect((await turn(page(three), `${ask}\n아 그냥 3개만`, three)).out).toBe(page(three))
})
