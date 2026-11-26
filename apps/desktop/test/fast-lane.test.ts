import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentTool, Engine, ToolSessionJob } from 'core'
import { answer, openWorld } from '../src/main/answer.js'

async function turn(page: string, ask: string, draft: string) {
  const quick = vi.fn<(prompt: string) => Promise<string>>(async () => '')
  let out = ''
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async () => page }
  const engine = { id: 'claude', quick, desktopToolIsolation: true, run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: ToolSessionJob) => { if (page) out = String(await job.tools.find(one => one.name === 'search_web')!.run({ query: 'q' })); return { answer: draft } } } as unknown as Engine
  const root = await mkdtemp(join(tmpdir(), 'fast-lane-'))
  try {
    const { result } = await answer(await openWorld(root, engine), ask, { tools: [search] })
    return { out, answer: result?.answer, judged: quick.mock.calls.filter(([prompt]) => prompt.includes(draft)).length, rows: out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\/\/\S+)/.exec(line)?.[1] ?? line) }
  } finally { await rm(root, { recursive: true, force: true }) }
}

it('gives a short question and a short job the same call, and the host asks neither to be brief', async () => {
  const jobs: { told: string; tools: string[]; maxCalls: number; modelHint?: string; effort?: string }[] = []
  const engine = { id: 'mock', desktopToolIsolation: true, run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: ToolSessionJob) => { jobs.push({ told: [job.system, job.opening, job.prompt].join('\n'), tools: job.tools.map(one => one.name), maxCalls: job.maxCalls, ...(job.modelHint ? { modelHint: job.modelHint } : {}), ...(job.effort ? { effort: job.effort } : {}) }); return { answer: '네.' } } } as unknown as Engine
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async () => '' }
  const root = await mkdtemp(join(tmpdir(), 'fast-lane-'))
  try {
    for (const ask of ['하루는 몇 분이야?', '휴가 신청 메일 써줘']) await answer(await openWorld(join(root, String(jobs.length)), engine), ask, { tools: [search] })
  } finally { await rm(root, { recursive: true, force: true }) }
  expect(jobs).toHaveLength(2)
  for (const job of jobs) expect(job.told).not.toContain('This is a short ask')
  expect({ ...jobs[0]!, told: '' }).toEqual({ ...jobs[1]!, told: '' })
})

it('gives a lookup the shell and the full menu like any turn, and hands mid-turn words to the running turn', () => {
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('tools: everyTool, ...(imagePaths ? { imagePaths } : {}) }, message, {')
  expect(ipc).toContain('...(native && !company ? { native } : {}),')
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('...(native ? { native } : {}),')
  expect(ipc).toContain('takeSteer: () => { const said = takeFollowUps(channel); steered.push(...said); return said }, steered: signal => followUpSaid(channel, signal)')
  expect(ipc).not.toMatch(/steerReplied|voice: \(\) => chatEngine/)
  expect(ipc).toContain('acknowledgeHanded(paths, bot.id, [...stored.pending, ...steered], checkpoint)')
  expect(readFileSync(new URL('../src/main/task-runner.ts', import.meta.url), 'utf8')).toContain('playbook ? { context: playbookContext(playbook), learned: true } : undefined')
  expect(ipc).toContain('steered: followUpSaid')
  expect(ipc).toContain('stop: stopChat,')
  expect(ipc).not.toMatch(/reply: !\(turn\?\.context/)
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).not.toMatch(/smallTalkAnswer|talked/)
})

it('a lone lookup gets the quick model\'s ack like any ask, and no lane file is left to pick it out', () => {
  expect(existsSync(new URL('../src/main/fast-lane.ts', import.meta.url))).toBe(false)
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc).not.toMatch(/linkVerdicts|linkAnswers|team\.cited|401, 403, 429/)
  expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
  expect(ipc.indexOf('await deliverOutputs(paths, native?.cwd ?? workFolder, result, nativeSince, request.message)')).toBeGreaterThan(0)
  expect(ipc.indexOf('await deliverOutputs(paths, native?.cwd ?? workFolder, result, nativeSince, request.message)')).toBeLessThan(ipc.indexOf('turnOutcomes.set(channel, { tokensUsed'))
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).not.toMatch(/whole|quickQuestion/)
})

it('a general-knowledge question reaches the lead as typed and its own sentence is the answer, with no quick call reading the draft', async () => {
  for (const [ask, said] of [['서울에서 부산까지 몇 km야?', '직선으로 약 325km예요.'], ['한 시간은 몇 초야?', '3,600초예요.']] as const) {
    const got = await turn('', ask, said)
    expect(got.answer, ask).toBe(said)
    expect(got.judged, ask).toBe(0)
  }
})

it('streams a lookup turn\'s words as they come, like any turn with no ack on screen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fast-lane-'))
  try {
    const note = 'Now I have the search results for all three cities. Let me check each one against the weather service page before I write the table, since the first result looked a day old and the second one did not carry a date at all. Searching the web for results once more.'
    expect([...note].length).toBeGreaterThan(200)
    const pieces = ['Now I have solid sources for all 5 items. ', 'Let me verify the article URL by reading it directly.', ...note.match(/[^]{1,40}/g)!, '지금 1달러에 1,385원이에요.']
    const engine = { id: 'mock', desktopToolIsolation: true, run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: ToolSessionJob) => { await new Promise(done => setTimeout(done, 20)); for (const piece of pieces) job.onToken?.(piece); return { answer: '지금 1달러에 1,385원이에요.' } } } as unknown as Engine
    const seen: boolean[] = []
    const search = { name: 'search_web', description: 'searches the web', argsSchema: { type: 'object' }, run: async () => '' }
    const { trace } = await answer(await openWorld(root, engine), '원달러 환율 지금 얼마야?', { tools: [search], onToken: (_, held) => { seen.push(held) } })
    expect(seen).toHaveLength(pieces.length)
    expect(seen.some(Boolean)).toBe(false)
    expect(trace.final.text).toBe('지금 1달러에 1,385원이에요.')
  } finally { await rm(root, { recursive: true, force: true }) }
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc).toContain("if (!held && !signal.aborted && !turn?.verification) broadcast({ type: 'chat:token', channel, text })")
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('const hold = !!firstLineNote(channel)')
  expect(ipc).toContain('onReset: (drop, tool) => { broadcast(')
})

it('posts a lookup\'s answer as written, a failure report included, and no host line is put after it', async () => {
  const fine = '11월 16일 종가 기준 155.26달러예요. [네이버 증권](https://search.naver.com/search.naver?query=x)'
  const linked = '엔비디아 주가 정보를 지금 바로 가져오지 못했어요. [네이버 증권](https://search.naver.com/search.naver?query=x)'
  const failed = '엔비디아 주가 정보를 지금 바로 가져오지 못했어요. 확인되는 대로 다시 알려드릴게요.'
  const list = '세 건 찾았고 나머지 둘은 찾지 못했어요.\n1. 업스테이지가 1,500억 원 투자받았대요. [글로벌경제](https://example.com/a)\n2. 뤼튼이 300억 원 유치했어요. [전자신문](https://example.com/b)'
  for (const answer of [fine, '픽셀 11은 아직 공식 가격이 안 나와서 예상가를 적었어요.', linked, failed, list]) expect((await turn('', '토트넘 어젯밤 경기 점수 몇 대 몇이야?', answer)).answer, answer).toBe(answer)
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
