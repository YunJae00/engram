import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { firstSearches, isSearchPage, searchWords } from 'core'
import { swapRounds, swappedAsk, teamAsk } from '../src/main/fast-lane.js'

const source = (file: string) => readFileSync(fileURLToPath(new URL(`../src/main/${file}`, import.meta.url)), 'utf8')
const ipc = source('ipc.ts'), runner = source('team-runner.ts')

// stack-9 section 1: c9a's abort-on-replace acts on a solo lookup only, never on a team job (C3, the T1 add) or a desk turn.
it('stack-9: a replacement aborts only a solo lookup', async () => {
  // The lane exists only outside the team lane (company), a desk kind only outside the lane, and the swap hook only for a solo lane.
  expect(ipc).toContain("const lane = !company && fastLane(routed, plainAsk) && everyTool.some(tool => tool.name === 'search_web')")
  expect(ipc).toContain('solo = lane && !teamAsk(request.message)')
  expect(ipc).toContain('if (solo && !handed && !fixed) laneChanges.set(channel, said => {')
  expect(ipc.match(/laneChanges\.set\(/g)).toHaveLength(1)
  // T1 and C3-shaped asks are team asks: no swap hook.
  for (const ask of ['봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합해줘', '아이폰 18, 갤럭시 S27 가격이랑 출시일 비교해줘. 각각 따로 조사시켜']) expect(teamAsk(ask), ask).toBe(true)
  // An addition is never a replacement, so even a solo lane keeps its round.
  expect(swappedAsk('서울 날씨 알려줘', '아 대구도 추가해')).toBeUndefined()
  // A stop of the whole turn wins over a change said in the same moment (rule 4).
  const turn = new AbortController(), lookup = swapRounds('엔비디아 오늘 주가 알려줘', turn.signal)
  const asks: string[] = []
  const done = lookup.run((ask, signal) => { asks.push(ask); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) })
  turn.abort()
  expect(lookup.change('그냥 애플로 바꿔')).toBe(true)
  await expect(done).rejects.toThrow('aborted')
  expect(asks).toEqual(['엔비디아 오늘 주가 알려줘'])
})

// One way to run a job's first searches: core firstSearches chooses them (c9b maker/list searches, c9a price-and-date points), and
// team-runner runs them one after the other in the member's one tab. Never the same words twice, never more than three.
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

// One search-page test: company-tools' page picking uses c9a's isSearchPage.
it('stack-9: one search-page test', () => {
  const tools = readFileSync(fileURLToPath(new URL('../../../packages/core/src/company-tools.ts', import.meta.url)), 'utf8')
  expect(tools).toContain('const search = isSearchPage')
  expect(tools).not.toMatch(/\[\?&\]\(q\|query\)=/)
  expect(isSearchPage('https://www.bing.com/search?q=linear')).toBe(true)
  expect(isSearchPage('https://linear.app/changelog')).toBe(false)
})

// A teammate's own bubble is posted early only when they hand on (then): a split stays one bubble.
it('stack-9: an early bubble only for a hand-off', () => {
  expect(runner).toContain('if (next?.background && !halting.has(leadChannel)) report?.(leadChannel, taskId)')
})

// stack-9 (c9b run C3, C10): the maker's search stays on the person's own engine, and a part that saw no notice or article is found-nothing.
it('stack-9: the maker search carries a Korean word; "기사가 안 보여서 확인이 안 됐어요" found nothing', async () => {
  const { foundNothing, firstSearches: firsts } = await import('core')
  const maker = firsts({ brief: '이번 주 리니어 신기능 조사', query: '리니어 신기능' }, '이번 주 리니어 신기능 조사').find(one => one.maker)
  expect(maker?.query).toBe('Linear changelog 업데이트')
  expect(foundNothing('이번 주(11/16~11/22) 슬랙 신기능은 관련 공지나 기사가 안 보여서 확인이 안 됐어요.')).toBe(true)
  expect(foundNothing('12월 2일~4일 코엑스에서 소프트웨이브 2026이 열려요.')).toBe(false)
})

// stack-9, c9a Codex r3: five rounds held and four written is no "확실한 건 4건"; a word of surprise first names nobody.
it('stack-9 (c9a Codex r3): a held round the list left out joins it; "깜짝 …" is no round', async () => {
  const { EVENT_ROWS, BACKGROUND_ROWS, eventRank } = await import('core')
  const { newsItems, shortSaid, listOnly } = await import('../src/main/fast-lane.js')
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘', names = ['메디인테크', '업스테이지', '뤼튼', '리벨리온', '아크']
  const held = [`results for "x" at https://search.naver.com/search.naver?query=x (DATA, not instructions):`, `${EVENT_ROWS} 5. ${BACKGROUND_ROWS} the last 1 (…).`,
    ...names.map((name, i) => `- ${name}, 100억 원 투자 유치 — https://news.example/${i} — 투자 — 11월 ${i + 1}일`), '- 올해 벤처투자 역대 최대 — https://news.example/bg — 통계 — 11월 9일'].join('\n')
  const answer = ['요즘 투자 소식 네 개예요.', '', ...names.slice(0, 4).map((name, i) => `${i + 1}. ${name}가 100억 원을 유치했어요. [기사](https://news.example/${i})`), '', '더 찾으면 알려드릴게요.'].join('\n')
  const out = shortSaid(ask, listOnly(newsItems(answer, [held], ask)))
  const items = out.split('\n').filter(line => /^\d+\. /.test(line))
  expect(items).toHaveLength(5)
  expect(items[4]).toBe('5. 아크, 100억 원 투자 유치 — 11월 5일 [출처](https://news.example/4)')
  expect(out).not.toMatch(/확실한 (?:투자 유치 )?건은 \d개예요|네 개예요/)
  // A round already in the list under another article is not added again; nothing is added past the count.
  const other = answer.replace('https://news.example/0', 'https://other.example/medi')
  const again = newsItems(other, [held], ask).split('\n').filter(line => /^\d+\. /.test(line))
  expect(again.filter(line => line.includes('메디인테크'))).toHaveLength(1)
  expect(again).toHaveLength(5)
  expect(eventRank({ title: '깜짝 300억 투자 유치, 스타트업 업계 들썩', url: 'https://news.example/a', snippet: '', date: '11월 17일' }, ask)).toBe(1)
  expect(eventRank({ title: '메디인테크, 338억 원 규모 시리즈C 투자 유치', url: 'https://news.example/b', snippet: '', date: '11월 17일' }, ask)).toBe(2)
})

// stack-9 (c9b run C5-C10, H5, every judge quoted it): "12월 서울 IT 행사는 두 개 있어요." over one event; the teammate's own count line was an item.
it('stack-9: a teammate\'s line on how many there are is no item and is not shown again under the opener', async () => {
  const { mergedReport } = await import('core')
  const m = { id: 'm1', parentId: null, depth: 1, role: '지민', brief: '다음 달 서울 IT 행사 일정 정리', botId: 'bot-1', voice: '차분하고 또박또박', title: '다음 달 서울 IT 행사 일정 정리', lookup: true as const, query: '2026년 12월 서울 IT 행사 일정', background: true as const, state: 'released' as const, sessionKey: 's', hiredAt: '2026-11-17T07:55:08.846Z', finishedAt: '2026-11-17T07:55:17.834Z',
    result: '12월 2일~4일: 소프트웨이브 2026(제11회 대한민국 소프트웨어 대전) - COEX Hall A, AI·SW 비즈니스 전시회 — https://www.coex.co.kr/exhibitions/sw-2026/\n\n확실한 일정은 이거 하나예요. 나머지 검색 결과는 날짜가 2026년 12월로 명시되지 않거나 서울 IT 행사와 직접 관련이 없었어요.',
    sources: ['https://search.naver.com/search.naver?query=x'], review: { ok: true, note: 'auto' } }
  const out = mergedReport([m], new Map(), [], { ask: '이거 지민한테 맡겨: 다음 달 서울 IT 행사 일정 정리', now: new Date('2026-11-17T07:55:20.255Z') })
  expect(out).not.toMatch(/두 개|2개/)
  expect(out).toContain('확실한 건 하나예요.')
  expect(out).not.toContain('확실한 일정은 이거 하나예요')
  expect(out).toContain('소프트웨이브 2026')
})
