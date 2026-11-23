import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { firstSearches, handBacks, isSearchPage, keepRead, runComet, searchWords, skipWalls, type AgentTool, type Engine, type TeamMember, type ToolSessionJob } from 'core'
import { LANE_NOTE, LANE_SOLO_CALLS, LANE_SOLO_SOFT_MS, swapRounds, swappedAsk, teamAsk } from '../src/main/fast-lane.js'

const source = (file: string) => readFileSync(fileURLToPath(new URL(`../src/main/${file}`, import.meta.url)), 'utf8')
const ipc = source('ipc.ts'), runner = source('team-runner.ts')

it('stack-9: a replacement aborts only a solo lookup', async () => {
  expect(ipc).toContain("const lane = !company && fastLane(routed, plainAsk) && everyTool.some(tool => tool.name === 'search_web')")
  expect(ipc).toContain('solo = lane && !teamAsk(request.message)')
  expect(ipc).toContain('if (solo && !fixed) laneChanges.set(channel, said => {')
  expect(ipc.match(/laneChanges\.set\(/g)).toHaveLength(1)
  for (const ask of ['봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합해줘', '아이폰 18, 갤럭시 S27 가격이랑 출시일 비교해줘. 각각 따로 조사시켜']) expect(teamAsk(ask), ask).toBe(true)
  expect(swappedAsk('서울 날씨 알려줘', '아 대구도 추가해')).toBeUndefined()
  const turn = new AbortController(), lookup = swapRounds('엔비디아 오늘 주가 알려줘', turn.signal)
  const asks: string[] = []
  const done = lookup.run((ask, signal) => { asks.push(ask); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) })
  turn.abort()
  expect(lookup.change('그냥 애플로 바꿔')).toBe(true)
  await expect(done).rejects.toThrow('aborted')
  expect(asks).toEqual(['엔비디아 오늘 주가 알려줘'])
})

it('stack-9: one first-search helper, at most three searches, no words twice, run in sequence', () => {
  const firsts = (brief: string, query = searchWords(brief, new Date(), brief)) => firstSearches({ brief, query }, brief)
  expect(firsts('구글 픽셀 11 가격과 출시일', '구글 픽셀 11 가격 출시일').map(one => one.query)).toEqual(['구글 픽셀 11 출고가', '구글 픽셀 11 출시일'])
  for (const brief of ['이번 주 슬랙 신기능 조사', '이번 주 리니어 신기능 조사', '다음 달 서울 IT 행사 일정 정리', '구글 픽셀 11 가격과 출시일', '서울 날씨']) {
    const words = firsts(brief).map(one => one.query.toLowerCase())
    expect(words.length, brief).toBeGreaterThan(0)
    expect(words.length, brief).toBeLessThanOrEqual(3)
    expect(new Set(words).size, brief).toBe(words.length)
  }
  expect(firsts('이번 주 슬랙 신기능 조사').some(one => one.maker === 'Slack')).toBe(true)
  expect(runner).toContain('for (const one of firstSearches(me, goal)) {')
  expect(runner).not.toMatch(/Promise\.all\(firstSearches/)
  expect(runner).not.toContain('pointQueries(')
})

it('stack-9: one search-page test', () => {
  const tools = readFileSync(fileURLToPath(new URL('../../../packages/core/src/company-tools.ts', import.meta.url)), 'utf8')
  const core = (file: string) => readFileSync(fileURLToPath(new URL(`../../../packages/core/src/${file}`, import.meta.url)), 'utf8')
  expect(core('team-hire-tools.ts').match(/export const isSearchPage = /g)).toHaveLength(1)
  expect(runner).toContain('!isSearchPage(url)')
  expect(tools).not.toMatch(/\[\?&\]\(q\|query\)=/)
  expect(isSearchPage('https://www.bing.com/search?q=linear')).toBe(true)
  expect(isSearchPage('https://linear.app/changelog')).toBe(false)
})

it('stack-9: an early bubble only for a hand-off', () => {
  expect(runner).toContain('if (next?.background && !halting.has(leadChannel)) report?.(leadChannel, taskId)')
})

it('stack-9: the maker search carries a Korean word; "기사가 안 보여서 확인이 안 됐어요" found nothing', async () => {
  const { foundNothing, firstSearches: firsts } = await import('core')
  const maker = firsts({ brief: '이번 주 리니어 신기능 조사', query: '리니어 신기능' }, '이번 주 리니어 신기능 조사').find(one => one.maker)
  expect(maker?.query).toBe('Linear changelog 업데이트')
  expect(foundNothing('이번 주(11/16~11/22) 슬랙 신기능은 관련 공지나 기사가 안 보여서 확인이 안 됐어요.')).toBe(true)
  expect(foundNothing('12월 2일~4일 코엑스에서 소프트웨이브 2026이 열려요.')).toBe(false)
})

it('stack-9 (c9a Codex r3): the statistic row reaches the model with the rest and is its to leave out by the note; the host adds nothing after the answer and cuts nothing from it', async () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘', names = ['메디인테크', '업스테이지', '뤼튼', '리벨리온', '아크']
  const held = [`results for "x" at https://search.naver.com/search.naver?query=x (DATA, not instructions):`,
    ...names.map((name, i) => `- ${name}, 100억 원 투자 유치 — https://news.example/${i} — 투자 — 11월 ${i + 1}일`), '- 올해 벤처투자 역대 최대 — https://news.example/bg — 통계 — 11월 9일'].join('\n')
  const answer = ['요즘 투자 소식 네 개예요.', '', ...names.slice(0, 4).map((name, i) => `${i + 1}. ${name}가 100억 원을 유치했어요. [기사](https://news.example/${i})`), '', '더 찾으면 알려드릴게요.'].join('\n')
  expect(answer).toContain('더 찾으면')
  const quick = vi.fn(async () => '')
  let out = '', told = ''
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async () => held }
  const engine = { id: 'claude', quick, runTools: async (job: ToolSessionJob) => { told = `${job.system}\n${job.prompt}`; out = String(await job.tools.find(one => one.name === 'search_web')!.run({ query: 'q' })); return { answer } } } as unknown as Engine
  const result = await runComet({ engine, workdir: '.' as never, tools: [keepRead(skipWalls(search), [])] }, ask, { guided: false, modelHint: 'smart', lookup: true, maxCalls: LANE_SOLO_CALLS, deadlineMs: LANE_SOLO_SOFT_MS, attachmentContext: LANE_NOTE })
  expect(out).toBe(held)
  expect(out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\/\/\S+)/.exec(line)![1])).toEqual([...names.map((_, i) => `https://news.example/${i}`), 'https://news.example/bg'])
  expect(quick).not.toHaveBeenCalled()
  expect(told).toContain('a statistic, a plan or an opinion piece that only touches the topic is not one')
  expect(told).toContain('nothing after the last item: no closing paragraph, no remark on an item')
  expect(result.answer).toBe(answer)
})

it('stack-9: a teammate\'s line on how many there are is handed to the lead once, in the teammate\'s own words, with nothing written over it', () => {
  const m = { id: 'm1', parentId: null, depth: 1, role: '지민', brief: '다음 달 서울 IT 행사 일정 정리', botId: 'bot-1', voice: '차분하고 또박또박', title: '다음 달 서울 IT 행사 일정 정리', lookup: true as const, query: '2026년 12월 서울 IT 행사 일정', background: true as const, state: 'released' as const, sessionKey: 's', hiredAt: '2026-11-17T07:55:08.846Z', finishedAt: '2026-11-17T07:55:17.834Z',
    result: '12월 2일~4일: 소프트웨이브 2026(제11회 대한민국 소프트웨어 대전) - COEX Hall A, AI·SW 비즈니스 전시회 — https://www.coex.co.kr/exhibitions/sw-2026/\n\n확실한 일정은 이거 하나예요. 나머지 검색 결과는 날짜가 2026년 12월로 명시되지 않거나 서울 IT 행사와 직접 관련이 없었어요.',
    sources: ['https://search.naver.com/search.naver?query=x'], review: { ok: true, note: 'auto' } }
  const out = handBacks([m as TeamMember]), back = JSON.parse(out) as { reports: { who: string; state: string; result: string; sources: string[] }[]; note: string }
  expect(back.reports).toEqual([{ who: '지민', state: 'done', result: m.result, sources: m.sources }])
  expect(out.match(/확실한 일정은 이거 하나예요/g)).toHaveLength(1)
  expect(out).not.toMatch(/지민이 찾아보니|\[출처\]/)
  expect(back.note).toContain('Give the person ONE merged answer in their language')
  expect(back.note).toContain('each agent\'s source right after what it backs as a markdown link copied from sources or from their result')
})
