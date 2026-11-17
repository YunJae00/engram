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
  // c11a: a fact's page and a part's sources are told apart from search pages by that one test.
  expect(tools).toMatch(/import \{[^}]*\bisSearchPage\b[^}]*\} from '\.\/team-hire-tools\.js'/)
  expect(tools).toContain('!isSearchPage(f.url)')
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
// c11b: the host adds no held round to the list and writes no count: four of five is a gap said to the model, whatever the headlines say.
it('stack-9 (c9a Codex r3, c11b): four written of five asked is a gap for the model; the host adds nothing and judges no headline', async () => {
  const { listGap } = await import('../src/main/fast-lane.js')
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘', names = ['메디인테크', '업스테이지', '뤼튼', '리벨리온', '아크']
  const held = [`results for "x" at https://search.naver.com/search.naver?query=x (DATA, not instructions):`,
    ...names.map((name, i) => `- ${name}, 100억 원 투자 유치 — https://news.example/${i} — 투자 — 11월 ${i + 1}일`), '- 올해 벤처투자 역대 최대 — https://news.example/bg — 통계 — 11월 9일'].join('\n')
  const now = new Date(2026, 10, 17, 9, 30)
  const answer = ['요즘 투자 소식 네 개예요.', '', ...names.slice(0, 4).map((name, i) => `${i + 1}. ${name}가 100억 원을 유치했어요. [기사](https://news.example/${i})`), '', '더 찾으면 알려드릴게요.'].join('\n')
  expect(listGap(answer, [ask], [held], now)).toMatch(/^They asked for 5; 4 of/)
  // An item under another article than the row's counts by its own date; one link twice counts once.
  const other = answer.replace('https://news.example/0', 'https://other.example/medi').replace('1. 메디인테크가', '1. 메디인테크가 11월 1일')
  expect(listGap(other, [ask], [held], now)).toMatch(/^They asked for 5; 4 of/)
  expect(listGap(answer.replace('https://news.example/1', 'https://news.example/0'), [ask], [held], now)).toMatch(/^They asked for 5; 3 of/)
  // "깜짝 300억 …" and the statistic count like any linked, dated item.
  const five = [...answer.split('\n').filter(line => /^\d\. /.test(line)), '5. 깜짝 300억 투자 유치, 스타트업 업계 들썩 [기사](https://news.example/bg)'].join('\n')
  expect(listGap(five, [ask], [held], now)).toBeUndefined()
})

// stack-9 (c9b run C5-C10, H5, every judge quoted it): "12월 서울 IT 행사는 두 개 있어요." over one event; the teammate's own count line was an item.
it('stack-9: a teammate\'s line on how many there are is no item and is not shown again under the opener', async () => {
  const { mergedReport, reportData } = await import('core')
  const m = { id: 'm1', parentId: null, depth: 1, role: '지민', brief: '다음 달 서울 IT 행사 일정 정리', botId: 'bot-1', voice: '차분하고 또박또박', title: '다음 달 서울 IT 행사 일정 정리', lookup: true as const, query: '2026년 12월 서울 IT 행사 일정', background: true as const, state: 'released' as const, sessionKey: 's', hiredAt: '2026-11-17T07:55:08.846Z', finishedAt: '2026-11-17T07:55:17.834Z',
    result: '12월 2일~4일: 소프트웨이브 2026(제11회 대한민국 소프트웨어 대전) - COEX Hall A, AI·SW 비즈니스 전시회 — https://www.coex.co.kr/exhibitions/sw-2026/\n\n확실한 일정은 이거 하나예요. 나머지 검색 결과는 날짜가 2026년 12월로 명시되지 않거나 서울 IT 행사와 직접 관련이 없었어요.',
    sources: ['https://search.naver.com/search.naver?query=x'], review: { ok: true, note: 'auto' } }
  // c11a: the teammate hands back one fact and their remark on the count as their note; the host shows the one fact, never the note as an item.
  const data = reportData('```report\n' + JSON.stringify({ facts: [{ text: '12월 2일~4일 코엑스에서 소프트웨이브 2026이 열려요.', url: 'https://www.coex.co.kr/exhibitions/sw-2026/', date: '12월 2일' }], note: '확실한 일정은 이거 하나예요.' }) + '\n```', m, m.sources, true)
  expect(data?.facts).toHaveLength(1)
  const out = mergedReport([{ ...m, data: data! }])
  expect(out).not.toMatch(/두 개|2개/)
  expect(out).not.toContain('확실한 일정은 이거 하나예요')
  expect(out.split('\n')).toHaveLength(1)
  // c12a B1: never the job title as a label (this member was built without a part name). c13a (cause H): the find leads, then "(지민)".
  expect(out).toMatch(/^12월 2일~4일 코엑스에서 소프트웨이브 2026이 열려요\. \(지민\) \[[^\]]+\]\(https:\/\/www\.coex\.co\.kr\/exhibitions\/sw-2026\/\)$/)
  expect(out).not.toContain('[출처]')
})
