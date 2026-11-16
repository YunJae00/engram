import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createTask, listTasks, parseAsk, updateTask, type DelegatedTask, type VaultPaths } from '../src/index.js'
import { TEAM_LEAD_RULE } from '../src/agent-voice.js'
import { liveLinks, liveCited, linkAnswers, siteName, LINK_CHECK_MS, LOOKUP_RULE, LOOKUP_HARD_MS, LOOKUP_MAX_CALLS, LOOKUP_SOFT_MS, citeMembers, citeOwn, keepRead, keepSources, answeredLookup, AUTO_REVIEW, skipWalls, cutShortAnswer, failOnRestart, memberPersona, memberTask, settleMember, withoutExtras, teamHireTools, teamNote, teamReviewIssue, teamTree, teamUnverified, TEAM_TOKEN_RESERVE, type MemberRedo, type TeamHost } from '../src/team-hire-tools.js'

const three = [{ role: '서울 조사', brief: 'Seoul weather', deliverable: 'summary' }, { role: '제주 조사', brief: 'Jeju weather', deliverable: 'summary' }, { role: '부산 조사', brief: 'Busan weather', deliverable: 'summary' }]

function world(goal = '서울·제주·부산 날씨 조사해서 PDF로') {
  const task: DelegatedTask = { id: 't1', goal, botId: 'b1', state: 'running', turns: 1, createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z', approvals: [], log: [] }
  const state = { task, tokens: 200_000, said: goal, runs: [] as { id: string; redo?: MemberRedo }[], released: [] as string[], answer: (id: string) => `result of ${id}`, asks: new Set<string>(), gate: undefined as Promise<void> | undefined, steer: undefined as Promise<void> | undefined, live: new Set<string>() }
  const host = (self: string | null): TeamHost => ({
    self,
    load: async () => structuredClone(state.task),
    change: async work => work(state.task),
    run: async (ids, _signal, redo) => {
      for (const id of ids) state.live.add(id)
      await state.gate
      for (const id of ids) { state.live.delete(id); state.runs.push({ id, ...(redo ? { redo } : {}) }); const m = state.task.team!.members.find(one => one.id === id)!; if (state.asks.delete(id)) { m.state = 'waiting'; m.result = state.answer(id) } else if (m.lookup) settleMember(m, { answer: state.answer(id) }, 'now'); else { m.state = 'done'; m.result = state.answer(id) } }
    },
    release: async ids => { for (const id of ids) { state.released.push(id); state.task.team!.members.find(one => one.id === id)!.state = 'released' } },
    live: id => state.live.has(id),
    tokensLeft: async () => state.tokens,
    personSaid: () => state.said,
    ...(state.steer ? { steered: () => state.steer! } : {}),
  })
  const call = (self: string | null, name: string, args: Record<string, unknown> = {}) => teamHireTools(host(self)).find(tool => tool.name === name)!.run(args, { task: '' })
  return { state, call, tools: (self: string | null) => teamHireTools(host(self)) }
}

describe('team hire tools', () => {
  it('tells the lead not to hire for a simple ask; a task without a team needs no team check', () => {
    expect(TEAM_LEAD_RULE).toContain('never hire')
    expect(TEAM_LEAD_RULE).toContain('prefer 1 to 3 members')
    const { state } = world()
    expect(state.task.team).toBeUndefined()
    expect(teamUnverified(state.task)).toBe(false)
  })

  it('hires three members, runs them and returns each result', async () => {
    const { state, call } = world()
    const out = JSON.parse(await call(null, 'hire_members', { members: three, notes: 'Use Celsius' }))
    expect(out.members.map((m: { id: string; state: string; result: string }) => [m.id, m.state, m.result])).toEqual([['m1', 'done', 'result of m1'], ['m2', 'done', 'result of m2'], ['m3', 'done', 'result of m3']])
    expect(out.hiresLeft).toBe(5)
    expect(state.task.team!.members[0]).toMatchObject({ parentId: null, depth: 1, sessionKey: 'team-t1-m1' })
    expect(state.task.team!.members[0]!.brief).toContain('Notes from the lead:\nUse Celsius')
    expect(teamUnverified(state.task)).toBe(true)
    expect(teamReviewIssue(state.task)).toContain('서울 조사 (m1)')
  })

  // perf146: the Busan member's brief said "가능하면 미세먼지"; it chased air quality for 90 s after the weather and the lead waited.
  it('cuts optional extras the person did not ask for out of a brief, and keeps a lookup flag', async () => {
    expect(withoutExtras('부산 오늘 날씨를 조사해 주세요. 가능하면 미세먼지도 알려 주세요.', '부산 날씨 조사해줘')).toBe('부산 오늘 날씨를 조사해 주세요.')
    expect(withoutExtras('Busan weather today, and if possible the air quality', 'Busan weather')).toBe('Busan weather today')
    expect(withoutExtras('부산 날씨. 가능하면 미세먼지도.', '부산 날씨랑 가능하면 미세먼지도')).toBe('부산 날씨. 가능하면 미세먼지도.')
    expect(withoutExtras('가능하면 미세먼지', '부산 날씨')).toBe('가능하면 미세먼지')
    const { state, call } = world('봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘')
    await call(null, 'hire_members', { members: [{ role: '부산 조사', brief: '부산 오늘 날씨 조사. 가능하면 미세먼지도 조사.', deliverable: '기온과 하늘 상태 (가능하면 미세먼지)', lookup: true }, { role: '정리', brief: '표로 정리' }] })
    expect(state.task.team!.members[0]).toMatchObject({ brief: '부산 오늘 날씨 조사.', deliverable: '기온과 하늘 상태', lookup: true })
    expect(state.task.team!.members[1]!.lookup).toBeUndefined()
    expect(memberPersona(state.task.team!.members[0]!)).toContain('You only look things up')
    expect(memberPersona(state.task.team!.members[1]!)).not.toContain('You only look things up')
    expect(TEAM_LEAD_RULE).toContain('asks for bots, members or a team, hire them')
    expect(TEAM_LEAD_RULE).toContain('at most 3 short lines')
  })

  // grokbar: three review_member rounds cost ~10 s of a 71 s answer; a sourced lookup needs none, and then no team check turn either.
  it('accepts a lookup member that finished on its own with a source; any other member keeps the review', async () => {
    const m = { id: 'm1', parentId: null, depth: 1, role: 'r', brief: 'b', lookup: true as const, state: 'working' as const, sessionKey: 'k', hiredAt: '' }
    const settled = (outcome: Parameters<typeof settleMember>[1], patch: Record<string, unknown> = {}) => { const one = { ...m, ...patch } as Parameters<typeof settleMember>[0]; settleMember(one, outcome, 'now', true); return one }
    expect(settled({ answer: '서울 12도 맑음 (https://weather.example/seoul)' }).review).toEqual({ ok: true, note: AUTO_REVIEW })
    // stack-1: an employee handed work by assign is settled here too, by the same rule: a sourced lookup that answered, in the background or not; a job that makes something, or a reply with no answer in it, is not.
    expect(settled({ answer: '서울 12도 맑음 (https://weather.example/seoul)' }, { botId: 'b1', background: true }).review).toEqual({ ok: true, note: AUTO_REVIEW })
    expect(settled({ answer: '서울 12도 맑음 (https://weather.example/seoul)' }, { botId: 'b1', lookup: undefined }).review).toBeUndefined()
    expect(settled({ answer: '지금 검색하겠습니다. https://search.naver.com/search.naver?query=x' }, { botId: 'b1' }).review).toBeUndefined()
    expect(settled({ answer: '서울 12도 맑음' }).review).toBeUndefined()
    expect(settled({ answer: '서울 12도 (https://weather.example/seoul)', timedOut: true }).review).toBeUndefined()
    expect(settled({ answer: '서울 12도 (https://weather.example/seoul)', budgetExhausted: true }).review).toBeUndefined()
    expect(settled({ answer: '어느 도시인가요? https://weather.example', asked: true }).review).toBeUndefined()
    expect(settled({ answer: '', error: 'it was stopped.' }).review).toBeUndefined()
    expect(settled({ answer: '정리했어요 https://weather.example\n/tmp/out/weather.xlsx' }).review).toBeUndefined()
    expect(settled({ answer: '서울 12도 (https://weather.example/seoul)' }, { lookup: undefined }).review).toBeUndefined()
    // grokbar review r1: a link alone is not an answer. An opening line, a results page as the only source, a wall or an error keep the lead's review.
    for (const answer of [
      '지금 검색하겠습니다. https://search.naver.com/search.naver?query=weather', '지금 검색하겠습니다. https://weather.example/seoul', "I'll look it up now. https://weather.example/seoul", '확인해 볼게요. 잠시만요. https://weather.example/seoul',
      '서울 12도 맑음 https://search.naver.com/search.naver?query=서울+날씨', '서울 12도 https://www.google.com/search?q=seoul+weather', '서울 12도 https://www.bing.com/search?q=seoul', '서울 12도 https://duckduckgo.com/?q=seoul+weather',
      '로봇 확인 화면이 떠서 읽지 못했습니다. https://shop.example/item/1', '페이지를 찾을 수 없습니다 (404 Not Found) https://shop.example/a', 'Access denied on https://shop.example/price so I could not read it', '오류가 발생했습니다. 가격 799달러 https://shop.example/a',
    ]) {
      expect(answeredLookup(answer), answer).toBe(false)
      expect(settled({ answer }), answer).toMatchObject({ state: 'done' })
      expect(settled({ answer }).review, answer).toBeUndefined()
    }
    for (const answer of ['엔비디아(NVDA) 종가 162.85달러 (-2.01%). 출처: https://finance.example/quote/NVDA', '갤럭시 S27은 내년 2월 공개가 유력하고 가격은 아직 발표되지 않았습니다.\nhttps://news.example/s27', '서울 12도 맑음. 검색: https://search.naver.com/search.naver?query=서울 출처: https://weather.example/seoul', 'Seoul is 12°C and clear today. https://weather.example/today/seoul'])
      expect(settled({ answer }).review, answer).toEqual({ ok: true, note: AUTO_REVIEW })
    expect(LOOKUP_RULE).toContain('never a search-results address')
    // grokbar stack-1 R1/T1: a weather member answers from the results page it read, so its only address is a search page. The read on
    // record is the evidence: it is accepted without a review round. Words alone, an opening line or a wall are still the lead's to review.
    const naver = ['https://search.naver.com/search.naver?query=서울+날씨']
    expect(settled({ answer: '서울 12.4도 흐림, 16시부터 비. https://search.naver.com/search.naver?query=서울+날씨', sources: naver }).review).toEqual({ ok: true, note: AUTO_REVIEW })
    expect(settled({ answer: '서울 12.4도 흐림, 16시부터 비.', sources: naver }).review).toEqual({ ok: true, note: AUTO_REVIEW })
    expect(settled({ answer: '지금 검색하겠습니다.', sources: naver }).review).toBeUndefined()
    expect(settled({ answer: '로봇 확인 화면이 떠서 읽지 못했습니다.', sources: naver }).review).toBeUndefined()
    expect(settled({ answer: '서울 12.4도 흐림', sources: naver, timedOut: true }).review).toBeUndefined()
    expect(answeredLookup('서울 12.4도 흐림', naver)).toBe(true)
    // A lone lookup's answer names the page it read when its words gave no address; one that has an address is left alone.
    expect(citeOwn('지금 1달러에 1,335.40원이에요.\n\n네이버 환율 검색 결과', ['https://search.naver.com/search.naver?query=원달러 환율'], true)).toBe('지금 1달러에 1,335.40원이에요.\n\n네이버 환율 검색 결과 [네이버 금융](https://search.naver.com/search.naver?query=원달러%20환율)')
    // grokbar c3 L2/L4: "출처: bing.com" on a line of its own read like a printout. One named link after the last sentence, a page of its own before a results page.
    expect(citeOwn('Seoul is 12°C.', ['https://www.google.com/search?q=seoul', 'https://www.weather.example/seoul'])).toBe('Seoul is 12°C. [weather.example](https://www.weather.example/seoul)')
    expect(citeOwn('엔비디아는 159.22달러예요.', ['https://www.bing.com/search?q=NVDA'], true)).toBe('엔비디아는 159.22달러예요. [Bing 검색](https://www.bing.com/search?q=NVDA)')
    expect(citeOwn('엔비디아는 159.22달러예요.', ['https://www.bing.com/search?q=NVDA'], true)).not.toMatch(/출처|bing\.com\]/)
    // After a table or a list the link is a line of its own, never glued into the last row.
    expect(citeOwn('| 종목 | 가격 |\n|---|---|\n| NVDA | 159 |', ['https://finance.example/nvda'], true)).toBe('| 종목 | 가격 |\n|---|---|\n| NVDA | 159 |\n\n[finance.example](https://finance.example/nvda)')
    expect(citeOwn('- 첫째\n- 둘째', naver, true)).toBe('- 첫째\n- 둘째\n\n[네이버 날씨](https://search.naver.com/search.naver?query=서울+날씨)')
    const linked = '1,335원이에요. [네이버 금융](https://finance.naver.com)'
    expect(citeOwn(linked, naver, true)).toBe(linked)
    expect(citeOwn('1,335원이에요.', [], true)).toBe('1,335원이에요.')
    // stack-3 (c3a run L1, L2, T2): the model's one link on a line of its own joins the last sentence; under a table or a list it stays where it is.
    expect(citeOwn('오늘 서울은 오후부터 비가 와요.\n\n퇴근길 우산 챙기세요.\n\n[네이버 날씨](https://weather.naver.com/today)', naver, true)).toBe('오늘 서울은 오후부터 비가 와요.\n\n퇴근길 우산 챙기세요. [네이버 날씨](https://weather.naver.com/today)')
    expect(citeOwn('애플은 352.34달러예요.\n[네이버 증권](https://finance.naver.com/aapl)\n', [], true)).toBe('애플은 352.34달러예요. [네이버 증권](https://finance.naver.com/aapl)')
    for (const kept of ['| 종목 | 가격 |\n|---|---|\n| NVDA | 159 |\n\n[finance.example](https://finance.example/nvda)', '- 첫째\n- 둘째\n\n[네이버 검색](https://search.naver.com/x)', '[네이버 날씨](https://weather.naver.com/today)']) expect(citeOwn(kept, naver, true)).toBe(kept)
    expect(citeOwn('', naver, true)).toBe('')

    const { state, call } = world('봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘')
    state.answer = id => id === 'm3' ? '부산 15도' : `${id} 12도 (https://weather.example/${id})`
    const out = JSON.parse(await call(null, 'hire_members', { members: three.map(one => ({ ...one, lookup: true })) }))
    expect(out.members.map((one: { id: string; state: string; accepted?: boolean }) => [one.id, one.state, one.accepted])).toEqual([['m1', 'released', true], ['m2', 'released', true], ['m3', 'done', undefined]])
    expect(out.note).toContain('do not call review_member for them')
    expect(out.note).toContain('For the others: Review each member')
    expect(state.released).toEqual(['m1', 'm2'])
    expect(teamReviewIssue(state.task)).toBe('Team members not reviewed yet: 부산 조사 (m3). Call review_member for each before reporting done.')
    await call(null, 'review_member', { id: 'm3', ok: true, note: 'fine' })
    expect(teamReviewIssue(state.task)).toBe('')

    const all = world('봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘')
    all.state.answer = id => `${id} 12도 (https://weather.example/${id})`
    const sourced = JSON.parse(await all.call(null, 'hire_members', { members: three.map(one => ({ ...one, lookup: true })) }))
    expect(sourced.note).not.toContain('Review each member')
    expect(teamReviewIssue(all.state.task)).toBe('')
    // A lead that reviews an accepted member anyway is told it is released, not refused.
    expect(JSON.parse(await all.call(null, 'review_member', { id: 'm1', ok: true, note: 'ok' }))).toEqual({ id: 'm1', state: 'released' })
    expect(all.state.task.team!.members[0]!.review).toEqual({ ok: true, note: AUTO_REVIEW })
  })

  // grokbar T1: "아 대구도 추가해" said while the lead waits on three members belongs in the same answer.
  it('returns early when the person speaks while the lead waits, and the next call hands back the members left working', async () => {
    const { state, tools } = world('봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘')
    state.answer = id => `${id} 12도 (https://weather.example/${id})`
    let finish!: () => void, speak!: () => void
    state.gate = new Promise(resolve => { finish = resolve })
    state.steer = new Promise(resolve => { speak = resolve })
    const lead = tools(null), hire = lead.find(tool => tool.name === 'hire_members')!
    const first = hire.run({ members: three.map(one => ({ ...one, lookup: true })) }, { task: '' })
    await new Promise(resolve => setTimeout(resolve, 5))
    speak()
    const early = JSON.parse(await first)
    expect(early.members.map((one: { id: string; state: string }) => [one.id, one.state])).toEqual([['m1', 'working'], ['m2', 'working'], ['m3', 'working']])
    expect(early.note).toContain('The person wrote to you while the team worked')
    // The added part is hired; the same call waits for the three still working and returns all four.
    // Words still waiting (a turn that takes none) do not end the next wait: one early return per turn.
    state.steer = Promise.resolve()
    const second = hire.run({ members: [{ role: '대구 조사', brief: 'Daegu weather', lookup: true }] }, { task: '' })
    await new Promise(resolve => setTimeout(resolve, 5))
    finish()
    const out = JSON.parse(await second)
    expect(out.members.map((one: { id: string; state: string }) => [one.id, one.state])).toEqual([['m1', 'released'], ['m2', 'released'], ['m3', 'released'], ['m4', 'released']])
    expect(teamReviewIssue(state.task)).toBe('')
    // Nothing left open: an empty call is refused as before.
    await expect(hire.run({ members: [] }, { task: '' })).rejects.toThrow('members needs 1 to 4 entries')
  })

  it('waits for the members left working when called with no new members; a member cannot be steered', async () => {
    const { state, tools } = world('서울 부산 제주 날씨')
    let finish!: () => void, speak!: () => void
    state.gate = new Promise(resolve => { finish = resolve })
    state.steer = new Promise(resolve => { speak = resolve })
    const hire = tools(null).find(tool => tool.name === 'hire_members')!
    const first = hire.run({ members: three }, { task: '' })
    await new Promise(resolve => setTimeout(resolve, 5))
    speak()
    expect(JSON.parse(await first).members.every((one: { state: string }) => one.state === 'working')).toBe(true)
    state.steer = new Promise(() => undefined)
    const wait = hire.run({ members: [] }, { task: '' })
    finish()
    expect(JSON.parse(await wait).members.map((one: { id: string; state: string }) => [one.id, one.state])).toEqual([['m1', 'done'], ['m2', 'done'], ['m3', 'done']])
    expect(state.task.team!.hires).toBe(3)
  })

  it('counts a time-boxed member\'s partial result as delivered, not failed', () => {
    const m = { id: 'm1', parentId: null, depth: 1, role: 'r', brief: 'b', state: 'working' as const, sessionKey: 'k', hiredAt: '' }
    const partial = { ...m }, empty = { ...m }, broken = { ...m }
    settleMember(partial, { answer: '부산 15도', timedOut: true }, 'now')
    expect(partial).toMatchObject({ state: 'done', result: '부산 15도\n(stopped at its time or call limit: this is what it had)' })
    // perf146 r2: a member that timed out with nothing delivered nothing: failed, and its note is one the thread never shows ("Failed: ").
    settleMember(empty, { answer: '', timedOut: true }, 'now')
    expect(empty).toMatchObject({ state: 'failed', result: 'Failed: it ran out of time before it reported anything.' })
    // c4 C3/H5: out of time with results in hand is not "nothing": what it read is its result, marked as read, with the pages it read.
    const rows = '부산 날씨: 맑음 15도, 2026.11.16. https://weather.example/busan'
    for (const answer of ['', '지금 검색하겠습니다.', '검색 결과를 열 수 없었습니다.']) {
      const cutShort: Parameters<typeof settleMember>[0] = { ...m, lookup: true }
      settleMember(cutShort, { answer, timedOut: true, read: rows, sources: ['https://search.example/?q=busan'] }, 'now', true)
      expect(cutShort, answer).toMatchObject({ state: 'done', read: true, result: `${rows}\n(시간 한도에서 멈춤: 여기까지 찾은 내용)`, sources: ['https://search.example/?q=busan'] })
      // Raw results are the lead's to read: never accepted on their own.
      expect(cutShort.review).toBeUndefined()
    }
    // c4b r3: what it wrote stands first, and the rows it had not got to stay under it with their addresses (one event of three was all that was left).
    const wrote: Parameters<typeof settleMember>[0] = { ...m }
    settleMember(wrote, { answer: '부산 15도', timedOut: true, read: rows }, 'now', true)
    expect(wrote).toMatchObject({ read: true, result: `부산 15도\n${rows}\n(시간 한도에서 멈춤: 여기까지 찾은 내용)` })
    const events = '12월 2일 소프트웨이브 https://example.com/a\n12월 5일 개발자 행사 https://example.com/b\n12월 9일 AI 행사 https://example.com/c'
    const one: Parameters<typeof settleMember>[0] = { ...m, lookup: true }
    settleMember(one, { answer: '12월 2일 소프트웨이브', timedOut: true, read: events }, 'now', true)
    expect(one).toMatchObject({ state: 'done', read: true, result: `12월 2일 소프트웨이브\n${events}\n(시간 한도에서 멈춤: 여기까지 찾은 내용)` })
    expect(one.review).toBeUndefined()
    // A row whose address the answer already names is not said twice; an answer that was not cut short is the whole result.
    const cited: Parameters<typeof settleMember>[0] = { ...m }
    settleMember(cited, { answer: '12월 2일 소프트웨이브 (https://example.com/a)', timedOut: true, read: events }, 'now', true)
    expect(cited.result).toBe('12월 2일 소프트웨이브 (https://example.com/a)\n12월 5일 개발자 행사 https://example.com/b\n12월 9일 AI 행사 https://example.com/c\n(시간 한도에서 멈춤: 여기까지 찾은 내용)')
    const whole: Parameters<typeof settleMember>[0] = { ...m }
    settleMember(whole, { answer: '12월 2일 소프트웨이브', read: events }, 'now', true)
    expect(whole).toMatchObject({ result: '12월 2일 소프트웨이브' })
    expect(whole.read).toBeUndefined()
    const long: Parameters<typeof settleMember>[0] = { ...m }
    settleMember(long, { answer: '', timedOut: true, read: '가'.repeat(5000) }, 'now', true)
    expect(long.result!.length).toBe(2000)
    // A member the person stopped, one that failed and one that asked keep nothing of what they read (GROKBOT rule 4).
    const stopped: Parameters<typeof settleMember>[0] = { ...m }, asked: Parameters<typeof settleMember>[0] = { ...m }
    settleMember(stopped, { answer: '', error: 'it was stopped.', read: rows }, 'now', true)
    expect(stopped).toMatchObject({ state: 'failed', result: 'Failed: it was stopped.' })
    expect(stopped.read).toBeUndefined()
    settleMember(asked, { answer: '어느 도시인가요?', asked: true, read: rows }, 'now', true)
    expect(asked).toMatchObject({ state: 'waiting', result: '어느 도시인가요?' })
    expect(asked.read).toBeUndefined()
    const korean = { ...m }
    settleMember(korean, { answer: '부산 15도', timedOut: true }, 'now', true)
    expect(korean).toMatchObject({ state: 'done', result: '부산 15도\n(시간 한도에서 멈춤: 여기까지 찾은 내용)' })
    expect((korean as { result?: string }).result).not.toMatch(/[A-Za-z]{4,}/)
    // perf146 r3: a member stopped while it was still announcing its first step delivered nothing.
    for (const line of ['지금 검색하겠습니다.', '서울 날씨를 찾아볼게요', 'Let me search for the Seoul weather.']) {
      const announced = { ...m }
      settleMember(announced, { answer: line, timedOut: true }, 'now', true)
      expect(announced).toMatchObject({ state: 'failed', result: 'Failed: it ran out of time before it reported anything.' })
    }
    const full = { ...m }
    settleMember(full, { answer: '지금 검색하겠습니다.\n서울 12도 (https://weather.example)', timedOut: true }, 'now', true)
    expect(full.state).toBe('done')
    settleMember(broken, { answer: '', error: 'it was stopped.' }, 'now')
    expect(broken.state).toBe('failed')
    expect(cutShortAnswer('Not verified as complete.\n\nThe tool-call or time limit was reached.\n\nUnverified response:\n부산 15도')).toBe('부산 15도')
    expect(cutShortAnswer('부산 15도')).toBe('부산 15도')
  })

  it('lets a member hire a helper at depth 2 and 3, and refuses a depth-3 member', async () => {
    const { state, call } = world()
    await call(null, 'hire_members', { members: [three[0]] })
    await call('m1', 'hire_members', { members: [{ role: 'helper', brief: 'part' }] })
    await call('m2', 'hire_members', { members: [{ role: 'deep', brief: 'part' }] })
    expect(state.task.team!.members.map(m => [m.id, m.parentId, m.depth])).toEqual([['m1', null, 1], ['m2', 'm1', 2], ['m3', 'm2', 3]])
    expect(await call('m3', 'hire_members', { members: [{ role: 'too deep', brief: 'part' }] })).toBe('Depth limit: a depth-3 member cannot hire. Do this part yourself.')
    expect(state.task.team!.members).toHaveLength(3)
  })

  it('enforces the hire budget, also for calls that arrive together', async () => {
    const { state, call } = world()
    const two = { members: [three[0], three[1]] }
    const outs = await Promise.all([call(null, 'hire_members', two), call(null, 'hire_members', two), call(null, 'hire_members', two), call(null, 'hire_members', two), call(null, 'hire_members', two)])
    expect(outs.filter(out => out.startsWith('Hire budget:'))).toHaveLength(1)
    expect(state.task.team!.hires).toBe(8)
    expect(await call(null, 'hire_members', { members: [three[2]] })).toBe('Hire budget: 8 of 8 used, 0 left. Hire at most 0 or do the work yourself.')
    expect(state.task.team!.members).toHaveLength(8)
  })

  it('refuses to hire when the token budget is nearly used', async () => {
    const { state, call } = world()
    state.tokens = TEAM_TOKEN_RESERVE - 1
    expect(await call(null, 'hire_members', { members: three })).toContain('token budget is nearly used')
    expect(state.task.team).toBeUndefined()
  })

  // grokbar B6: R1 38 s, R2 69 s, T1 70 s to the answer against 35 s. Plan ~8 s, review ~4 s, merge ~4 s leave the team about 15 s.
  it('bounds a lookup member so plan, team, review and merge fit 35 s', () => {
    const PLAN_MS = 8_500, REVIEW_MS = 4_000, MERGE_MS = 4_500
    expect(PLAN_MS + LOOKUP_HARD_MS + REVIEW_MS + MERGE_MS).toBeLessThanOrEqual(35_000)
    // After the soft limit the member still has time to write what it found.
    expect(LOOKUP_HARD_MS - LOOKUP_SOFT_MS).toBeGreaterThanOrEqual(5_000)
    expect(LOOKUP_MAX_CALLS).toBeLessThanOrEqual(4)
    expect(LOOKUP_RULE).toContain('about ten seconds')
    // grokbar c3 R2/C3: members reported "소스 접근 실패", "이번 턴 안에 내용을 읽어오지 못했습니다". They answer from the results list, in the
    // person's language, and say what is missing in a plain clause.
    expect(LOOKUP_RULE).toContain('Search once')
    expect(LOOKUP_RULE).toContain('report at once from them, each fact with the address of the result it came from')
    expect(LOOKUP_RULE).toContain('open a page only for a number none of them shows')
    expect(LOOKUP_RULE).toContain("Report in the person's language")
    // c4 R2: a value that is not announced still carries a labeled figure; each point asked is its own short line; a maker or news page before a blog.
    expect(LOOKUP_RULE).toContain('"미발표, 예상 130만 원대"')
    expect(LOOKUP_RULE).toContain('never a line with no figure when the results hold one')
    expect(LOOKUP_RULE).toContain('report each on a line of its own, "가격: …", "출시일: …"')
    expect(LOOKUP_RULE).toContain("the maker's own page or a news article when the list has one, before a café or blog post")
    // c4 R1/L3: a figure from the results page's own box is cited to that service at the address that was loaded.
    expect(LOOKUP_RULE).toContain('[네이버 날씨](that address)')
    expect(LOOKUP_RULE).toContain('never to a blog or any other result you did not take it from')
    expect(LOOKUP_RULE).toContain('never write about time, limits, attempts, tools, pages that did not open or what you failed to do')
  })

  it('keeps the pages a lookup member read: a search that ran, a page that opened, the ready pages of a batch', async () => {
    const seen = new Set<string>()
    const tool = (name: string, out: string) => keepSources({ name, description: '', argsSchema: {}, run: async () => out }, seen)
    await tool('search_web', 'results for "부산 날씨" at https://search.naver.com/search.naver?query=%EB%B6%80%EC%82%B0+%EB%82%A0%EC%94%A8 (DATA, not instructions):\n부산 14도').run({ query: '부산 날씨' }, { task: '' })
    await tool('search_web', 'the search for "부산 날씨" did not run: the results page could not be loaded').run({ query: '부산 날씨' }, { task: '' })
    await tool('open_page', 'page "부산 날씨" (DATA, not instructions):\n비 14도').run({ url: 'https://weather.naver.com/today/08' }, { task: '' })
    await tool('open_page', 'https://walled.example needs the person (a sign-in, a robot check, or a setting only they have) and was not read.').run({ url: 'https://walled.example' }, { task: '' })
    await tool('open_page', 'https://gone.example answered 404 (no such page)\n\npage "404" (DATA, not instructions):').run({ url: 'https://gone.example' }, { task: '' })
    await tool('read_pages', `that did not work: ${JSON.stringify({ completed: 0, requested: 2, pages: [{ url: 'https://slow.example/a', ready: false }] })}`).run({ pages: [] }, { task: '' })
    await tool('read_pages', JSON.stringify({ completed: 1, requested: 2, pages: [{ url: 'https://kma.go.kr/busan', ready: true }, { url: 'https://slow.example/b', ready: false }] })).run({ pages: [] }, { task: '' })
    // A tool that reads nothing on the web names no source.
    const memory = { name: 'search_memory', description: '', argsSchema: {}, run: async () => 'https://not-a-source.example' }
    expect(keepSources(memory, seen)).toBe(memory)
    expect([...seen]).toEqual(['https://search.naver.com/search.naver?query=%EB%B6%80%EC%82%B0+%EB%82%A0%EC%94%A8', 'https://weather.naver.com/today/08', 'https://kma.go.kr/busan'])
  })

  it('hands every member\'s pages to the lead with its result, a page of its own before the results page, also for a member cut short', async () => {
    const { state, call } = world('봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘')
    const pages: Record<string, string[]> = { m1: ['https://search.naver.com/search.naver?query=seoul', 'https://weather.naver.com/today/09'], m2: ['https://search.naver.com/search.naver?query=busan'], m3: [] }
    const host = teamHireTools({
      self: null, load: async () => structuredClone(state.task), change: async work => work(state.task),
      run: async ids => { for (const id of ids) settleMember(state.task.team!.members.find(m => m.id === id)!, { answer: `${id}: 14도, 비`, sources: pages[id]!, ...(id === 'm2' ? { timedOut: true } : {}) }, 'now', true) },
      release: async ids => { for (const id of ids) state.task.team!.members.find(m => m.id === id)!.state = 'released' },
      live: () => false, tokensLeft: async () => 200_000, personSaid: () => state.said,
    })
    const out = JSON.parse(await host.find(tool => tool.name === 'hire_members')!.run({ members: three.map(m => ({ ...m, lookup: true })) }, { task: '' }))
    expect(out.members.map((m: { sources?: string[] }) => m.sources)).toEqual([['https://weather.naver.com/today/09', 'https://search.naver.com/search.naver?query=seoul'], ['https://search.naver.com/search.naver?query=busan'], undefined])
    expect(out.note).toContain('markdown link')
    // grokbar c3 R1/R2: rows read "서울 (서울날씨봇)" and the closing line "출처: iPhone18 · GalaxyS27 · Pixel11".
    expect(out.note).toContain("the link text the site's own name")
    expect(out.note).toContain("never a member's role or name")
    expect(out.note).toContain('A row names a member only when the person named the members themselves')
    // One friendly lead and one table, no status sentence, and a plain line for a member that found nothing.
    expect(out.note).toContain('one friendly lead sentence that already gives the gist, then one table')
    expect(out.note).toContain('nothing after the table')
    expect(out.note).toContain('No status sentence about bots, members or collecting results')
    expect(out.note).toContain('"못 찾았어요"')
    expect(out.note).toContain('never re-run')
    void call
  })

  it('carries every member\'s link into its own row of the one merged table, and leaves an answer that already cites them alone', () => {
    const member = (id: string, role: string, sources: string[] | undefined, state = 'released', botId?: string) => ({ id, role, sources, state, parentId: null, depth: 1, brief: '', sessionKey: id, hiredAt: '', ...(botId ? { botId } : {}) }) as never
    const members = [member('m1', '서울 날씨', ['https://weather.naver.com/today/09']), member('m2', '부산 날씨', ['https://search.naver.com/search.naver?query=부산 날씨']), member('m3', '제주 날씨', ['https://weather.naver.com/today/14']), member('m4', '대구 날씨', undefined), member('m5', '광주 날씨', ['https://failed.example'], 'failed')]
    const table = '세 도시 날씨예요.\n\n| 도시 | 날씨 | 기온 | 출처 |\n|---|---|---|---|\n| 서울 | 구름많음 | 13.1°C | [네이버 날씨](https://weather.naver.com/today/09) |\n| 부산 | 비 | 14.0°C | 네이버 날씨 검색 |\n| 제주 | 흐림 | 15.6°C | 네이버 날씨 검색 |'
    const cited = citeMembers(table, members, true)
    // grokbar B6 r2: the link goes into the member's own row (a closing line left 부산 and 제주 with a site name alone). Still one table, no closing line.
    // grokbar c3 R1: a bot made for the job is not named in its row ("서울 (서울날씨봇)" read like a log).
    expect(cited).toBe('세 도시 날씨예요.\n\n| 도시 | 날씨 | 기온 | 출처 |\n|---|---|---|---|\n| 서울 | 구름많음 | 13.1°C | [네이버 날씨](https://weather.naver.com/today/09) |\n| 부산 | 비 | 14.0°C | [네이버 날씨 검색](https://search.naver.com/search.naver?query=부산%20날씨) |\n| 제주 | 흐림 | 15.6°C | [네이버 날씨 검색](https://weather.naver.com/today/14) |')
    for (const row of cited.split('\n').slice(4)) { expect(row).toMatch(/\]\(https:\/\//); expect(row).not.toMatch(/\((서울|부산|제주) 날씨\)/) }
    expect(citeMembers(cited, members, true)).toBe(cited)
    expect(cited).not.toContain('failed.example')
    // No source column: the row keeps its cells and gains the link.
    expect(citeMembers('| 도시 | 날씨 |\n|---|---|\n| **부산** | 비 14도 |', members.slice(1, 2), true)).toBe('| 도시 | 날씨 |\n|---|---|\n| **부산** | 비 14도 [출처](https://search.naver.com/search.naver?query=부산%20날씨) |')
    // Someone on the person's team is named in their row (GROKBOT rule 7), and an empty source cell is filled with the site's name, never theirs.
    const staff = [member('m1', '지민', ['https://www.notion.com/releases'], 'released', 'bot-jimin'), member('m2', '서연', ['https://slack.com/changelog'], 'released', 'bot-seoyeon'), member('m3', '도윤', undefined, 'released', 'bot-doyun')]
    expect(citeMembers('| 회사 | 신기능 | 출처 |\n|---|---|---|\n| 노션(지민) | AI 회의록 | - |\n| 슬랙(서연) | 캔버스 | 슬랙 블로그 |', staff, true)).toBe('| 회사 | 신기능 | 출처 |\n|---|---|---|\n| 노션(지민) | AI 회의록 | [notion.com](https://www.notion.com/releases) |\n| 슬랙(서연) | 캔버스 | [슬랙 블로그](https://slack.com/changelog) |')
    const namedStaff = [member('m1', '지민', ['https://www.notion.com/releases'], 'released', 'bot-jimin')]
    namedStaff[0]!['brief' as never] = '노션 신기능 조사' as never
    expect(citeMembers('| 회사 | 신기능 | 출처 |\n|---|---|---|\n| 노션 | AI 회의록 | 노션 블로그 |', namedStaff, true)).toBe('| 회사 | 신기능 | 출처 |\n|---|---|---|\n| 노션(지민) | AI 회의록 | [노션 블로그](https://www.notion.com/releases) |')
    // A row no single member answers for is left alone, and so is an answer with no table: those members get the closing line,
    // each link named for its site (grokbar c3 R2: "출처: iPhone18 · GalaxyS27 · Pixel11").
    const both = '| 항목 | 값 |\n|---|---|\n| 날씨 | 흐림 |'
    expect(citeMembers(both, members.slice(0, 2), true)).toBe(`${both}\n\n출처: [네이버](https://weather.naver.com/today/09) · [네이버 날씨](https://search.naver.com/search.naver?query=부산%20날씨)`)
    const phones = [member('m1', 'iPhone18', ['https://www.bing.com/search?q=iPhone+18']), member('m2', 'GalaxyS27', ['https://www.bing.com/search?q=Galaxy+S27']), member('m3', 'Pixel11', ['https://www.bing.com/search?q=iPhone+18'])]
    const closing = citeMembers('세 기종 모두 아직 공식 가격이 안 나왔어요.', phones, true)
    expect(closing).toBe('세 기종 모두 아직 공식 가격이 안 나왔어요.\n\n출처: [Bing 검색](https://www.bing.com/search?q=iPhone+18) · [Bing 검색](https://www.bing.com/search?q=Galaxy+S27)')
    expect(closing).not.toMatch(/iPhone18|GalaxyS27|Pixel11/)
    expect(citeMembers(table, members.slice(0, 1), true)).toBe(table)
    // A member with nothing to link (no pages kept, or failed) keeps its row as the lead wrote it.
    const missing = '| 도시 | 날씨 |\n|---|---|\n| 대구 | 아직 찾는 중이에요. |\n| 광주 | 못 찾았어요. |'
    expect(citeMembers(missing, members.slice(3), true)).toBe(missing)
    expect(citeMembers('Seoul 13°C', members.slice(0, 1))).toBe('Seoul 13°C\n\nSources: [Naver](https://weather.naver.com/today/09)')
    expect(citeMembers('', members, true)).toBe('')
    // stack-3 (c3a run R1, R2): a member that only searched and named the result's page in its own result is cited by the row that links
    // that page: no closing "출처: 네이버 검색 · 네이버 검색" under a table that links every row. A member with no link in the answer still gets one.
    const searched = members.slice(0, 2).map((m, i) => ({ ...(m as object), sources: [`https://search.naver.com/search.naver?query=${i}`], result: `맑아요. https://news.example/${i}.` }) as never)
    const linkedRows = '| 도시 | 날씨 | 출처 |\n|---|---|---|\n| 가 | 맑음 | [뉴스](https://news.example/0) |\n| 나 | 비 | [뉴스](https://news.example/1) |'
    expect(citeMembers(linkedRows, searched, true)).toBe(linkedRows)
    expect(citeMembers(linkedRows.replace('[뉴스](https://news.example/1)', '뉴스'), searched, true)).toContain('\n\n출처: [네이버 검색](https://search.naver.com/search.naver?query=1)')
  })

  // grokbar B6 T1: the lead re-ran the member that was cut at its time limit; 10.7 s for the same page.
  it('never re-runs a lookup member: ok=false releases it with what it had', async () => {
    const { state, call } = world()
    await call(null, 'hire_members', { members: [{ ...three[0]!, lookup: true }] })
    state.task.team!.members[0]!.review = undefined
    const out = await call(null, 'review_member', { id: 'm1', ok: false, note: '더 자세히' })
    expect(out).toContain('lookup member (never re-run)')
    expect(state.runs.map(run => run.id)).toEqual(['m1'])
    expect(state.task.team!.members[0]).toMatchObject({ state: 'released', review: { ok: false, note: '더 자세히' } })
    expect(state.task.team!.hires).toBe(1)
  })

  it('review ok=false re-runs a member once with the note, then releases it; ok=true releases', async () => {
    const { state, call } = world()
    await call(null, 'hire_members', { members: [three[0], three[1]] })
    const redo = JSON.parse(await call(null, 'review_member', { id: 'm1', ok: false, note: 'Add the humidity' }))
    expect(state.runs.at(-1)).toEqual({ id: 'm1', redo: { note: 'Add the humidity', answered: false } })
    expect(memberTask(state.task.team!.members[0]!, state.task.goal, state.runs.at(-1)!.redo)).toContain('Your lead reviewed this and asks for a redo:\nAdd the humidity')
    expect(redo.state).toBe('released')
    expect(state.task.team!.hires).toBe(3)
    expect(JSON.parse(await call(null, 'review_member', { id: 'm2', ok: true, note: 'good' }))).toEqual({ id: 'm2', state: 'released' })
    expect(state.task.team!.members[1]!.review).toEqual({ ok: true, note: 'good' })
    expect(state.released).toEqual(['m1', 'm2'])
    expect(teamReviewIssue(state.task)).toBe('')
  })

  it('does not run a second redo: the member is released with its last result', async () => {
    const { state, call } = world()
    await call(null, 'hire_members', { members: [three[0]] })
    state.task.team!.members[0]!.review = { ok: false, note: 'first' }
    const runs = state.runs.length
    expect(await call(null, 'review_member', { id: 'm1', ok: false, note: 'again' })).toContain('already redone once')
    expect(state.runs).toHaveLength(runs)
    expect(state.task.team!.members[0]!.state).toBe('released')
    expect(await call(null, 'review_member', { id: 'm1', ok: true, note: '' })).toContain('released')
    expect(await call('m1', 'review_member', { id: 'm1', ok: true, note: '' })).toBe('No member "m1" hired by you.')
  })

  it('hands a member question up with the role named and passes the answer back', async () => {
    const { state, call } = world()
    state.asks.add('m1'); state.answer = () => '이 메일 보내도 될까?'
    // The question is raised in the lead's thread by the tool itself (an ask ends the lead's turn), not left to another call.
    expect(parseAsk(await call(null, 'hire_members', { members: [{ role: '조사팀', brief: 'mail' }] }))?.question).toBe('조사팀: 이 메일 보내도 될까?')
    expect(state.task.team!.members[0]!.state).toBe('waiting')
    state.answer = () => 'sent'
    expect(JSON.parse(await call(null, 'review_member', { id: 'm1', ok: false, note: '보내도 돼' })).state).toBe('done')
    expect(state.runs.at(-1)!.redo).toEqual({ note: '보내도 돼', answered: true })
  })

  // perf146 r2: one member's sign-in question was the lead's whole answer while two cities had been reported.
  it('returns what the others delivered when one member needs the person, instead of ending on the question alone', async () => {
    const { state, call } = world()
    state.asks.add('m1'); state.answer = id => id === 'm1' ? '어느 계정으로 볼까?' : `${id} 15도`
    const raw = await call(null, 'hire_members', { members: [three[0], three[1], three[2]] })
    expect(parseAsk(raw)).toBeNull()
    const out = JSON.parse(raw)
    expect(out.members.map((m: { state: string }) => m.state)).toEqual(['waiting', 'done', 'done'])
    expect(out.members[0].ask).toBe('서울 조사: 어느 계정으로 볼까?')
    expect(out.note).toContain('give the person the combined answer')
    expect(out.note).toContain('close with the waiting member')
  })

  it('a lookup member skips a source that needs the person instead of asking about it; its own ask_person still asks', async () => {
    const ask = 'ASK: {"question":"열린 페이지에서 로그인이나 확인을 마치고 다 되면 알려줘.","options":[]}'
    const tool = (name: string, runRich = false) => ({ name, description: '', argsSchema: {}, run: async () => ask, ...(runRich ? { runRich: async () => ({ text: ask }) } : {}) })
    const skipped = await skipWalls(tool('open_page')).run({ url: 'https://search.example/?q=서울' }, { task: '' })
    expect(parseAsk(skipped)).toBeNull()
    expect(skipped).toContain('https://search.example/?q=서울 needs the person')
    expect(skipped).toContain('do not try to get past it')
    expect((await skipWalls(tool('open_page', true)).runRich!({}, { task: '' })).text).toContain('was not read')
    expect(await skipWalls({ ...tool('read_pages'), run: async () => 'page text' }).run({}, { task: '' })).toBe('page text')
    expect(parseAsk(await skipWalls(tool('ask_person')).run({}, { task: '' }))?.question).toContain('로그인')
  })

  it('asks every waiting member in one question; a member that asks again after the answer is asked again', async () => {
    const { state, call } = world()
    state.asks.add('m1'); state.asks.add('m2'); state.answer = id => `${id} question?`
    expect(parseAsk(await call(null, 'hire_members', { members: [three[0], three[1]] }))?.question).toBe('서울 조사: m1 question?\n제주 조사: m2 question?')
    state.asks.add('m1'); state.answer = () => 'one more?'
    expect(parseAsk(await call(null, 'review_member', { id: 'm1', ok: false, note: 'answer' }))?.question).toBe('서울 조사: one more?')
    expect(teamNote(state.task.team)).toContain('제주 조사 (m2) asked the person: m2 question?')
    expect(teamNote(state.task.team)).toContain('review_member({id:"m2", ok:false, note:<the answer>})')
  })

  it('a member released without any review still counts as unreviewed; a resumed member sees its open helpers', () => {
    const { state } = world()
    const base = { parentId: null, depth: 1, brief: 'b', hiredAt: state.task.createdAt }
    state.task.team = { members: [{ ...base, id: 'm1', role: 'r1', state: 'released', sessionKey: 'k1' }, { ...base, id: 'm2', role: 'r2', state: 'released', sessionKey: 'k2', review: { ok: true, note: '' } }], hires: 2, maxHires: 8, maxDepth: 3, big: false }
    expect(teamReviewIssue(state.task)).toBe('Team members not reviewed yet: r1 (m1). Call review_member for each before reporting done.')
    const helper = { ...base, id: 'm3', parentId: 'm1', depth: 2, role: 'helper', state: 'done' as const, sessionKey: 'k3', result: 'helper found it' }
    expect(memberTask(state.task.team.members[0]!, 'goal', { note: 'yes', answered: true }, [helper])).toContain('- helper (m3) [done]: helper found it')
  })

  it('shows a big plan first: a coding job is gated without the big flag, and a yes from the same turn does not approve it', async () => {
    const { state, call } = world('Yes')
    state.task.goal = 'Build a small todo app project'
    const coder = { members: [{ role: 'builder', brief: 'write the code' }] }
    expect(await call(null, 'hire_members', coder)).toContain('Big team plan: nothing was hired')
    expect(await call(null, 'hire_members', coder)).toContain('Big team plan: nothing was hired')
    expect(state.task.team).toMatchObject({ members: [], hires: 0, big: true })
    expect(state.task.team!.approvedAt).toBeUndefined()
    state.task.turns = 2; state.said = '고칠 점 말할게'
    expect(await call(null, 'hire_members', coder)).toContain('Big team plan')
    state.task.turns = 3; state.said = '이대로 진행'
    expect(JSON.parse(await call(null, 'hire_members', coder)).members).toHaveLength(1)
    expect(state.task.team!.approvedAt).toBeTruthy()
  })

  it('gates more than three members and the big flag the same way', async () => {
    const many = world(), flagged = world()
    expect(await many.call(null, 'hire_members', { members: [...three, { role: 'PDF', brief: 'make the pdf' }] })).toContain('Big team plan')
    expect(await flagged.call(null, 'hire_members', { members: [three[0]], big: true })).toContain('Big team plan')
    expect(many.state.runs).toHaveLength(0)
  })

  it('team_status lists the tree', async () => {
    const { state, call } = world()
    expect(await call(null, 'team_status')).toBe('No team on this task.')
    await call(null, 'hire_members', { members: [three[0]] })
    await call('m1', 'hire_members', { members: [{ role: 'helper', brief: 'part' }] })
    expect(await call(null, 'team_status')).toBe('- 서울 조사 (m1) [done] — result of m1\n  - helper (m2) [done] — result of m2\nhires 2/8')
    expect(teamTree(state.task.team)).toContain('hires 2/8')
  })

  it('marks members that were working as failed after a restart', async () => {
    const { state, call } = world()
    await call(null, 'hire_members', { members: [three[0], three[1]] })
    state.task.team!.members[0]!.state = 'working'
    expect(failOnRestart(state.task.team!, '2026-11-14T01:00:00.000Z')).toEqual(['m1'])
    expect(state.task.team!.members[0]).toMatchObject({ state: 'failed', result: 'Failed: the app restarted while this member was working.' })
  })

  it('persists the team on the task, loads old tasks unchanged and rejects a bad team', async () => {
    const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
    await mkdir(temporary, { recursive: true })
    const root = await mkdtemp(join(temporary, 'engram-team-core-')), paths = { cache: join(root, '.engram') } as unknown as VaultPaths
    const old = await createTask(paths, 'old task', 'b1')
    const task = await createTask(paths, 'team task', 'b1')
    const { state, call } = world()
    await call(null, 'hire_members', { members: three })
    await updateTask(paths, task.id, t => { t.team = structuredClone(state.task.team!) })
    const loaded = await listTasks(paths)
    expect(loaded.find(t => t.id === task.id)!.team).toEqual(state.task.team)
    expect(loaded.find(t => t.id === old.id)!.team).toBeUndefined()
    const file = join(paths.cache, 'tasks.json'), raw = JSON.parse(await readFile(file, 'utf8'))
    raw.tasks[1].team.members[0].depth = 4
    await writeFile(file, JSON.stringify(raw))
    await expect(listTasks(paths)).rejects.toThrow('Invalid saved tasks; the file was preserved.')
  })

  // grokbar c4 L3: the answer's only link was korea247.kr, a result the turn never opened, on a host that does not answer.
  it('checks each address the turn did not load once: a live link is kept, a dead one gives way to the page that was read, a slow one is kept', async () => {
    const read = ['https://search.naver.com/search.naver?query=부산 날씨']
    const asked: string[] = []
    const alive = (dead: string[], slow: string[] = []) => async (url: string, signal: AbortSignal): Promise<boolean> => {
      asked.push(url)
      if (slow.some(host => url.includes(host))) return new Promise<boolean>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      if (dead.some(host => url.includes(host))) throw new Error('net::ERR_NAME_NOT_RESOLVED')
      return true
    }
    // Live: kept as written. The page the turn loaded itself is not asked.
    const live = '부산은 맑고 18도예요. [기상청](https://www.weather.go.kr/w/index.do) [네이버 날씨](https://search.naver.com/search.naver?query=%EB%B6%80%EC%82%B0%20%EB%82%A0%EC%94%A8)'
    expect(await liveLinks(live, read, alive([]), true)).toBe(live)
    expect(asked).toEqual(['https://www.weather.go.kr/w/index.do'])
    // Dead (a network error, or the check says no): the page the turn read stands in, named as the service it is.
    const dead = '부산은 맑고 18도예요. 강수 소식은 없네요. [korea247.kr](https://korea247.kr/weather/busan)'
    const swapped = '부산은 맑고 18도예요. 강수 소식은 없네요. [네이버 날씨](https://search.naver.com/search.naver?query=부산%20날씨)'
    expect(await liveLinks(dead, read, alive(['korea247.kr']), true)).toBe(swapped)
    expect(await liveLinks(dead, read, async () => false, true)).toBe(swapped)
    // Nothing was read, or the read page is already linked: the link goes, its name stays as plain words, and no address is made up.
    expect(await liveLinks(dead, [], alive(['korea247.kr']), true)).toBe('부산은 맑고 18도예요. 강수 소식은 없네요. korea247.kr')
    expect(await liveLinks(`${live} [블로그](https://korea247.kr/x)`, read, alive(['korea247.kr']), true)).toBe(`${live} 블로그`)
    // One dead row of a table leaves the live rows alone; a longer address that starts the same is not touched.
    const table = '| 서울 | 12도 | [a](https://dead.example/a) |\n| 부산 | 18도 | [b](https://dead.example/a/b) |\n| 제주 | 20도 | [c](https://ok.example/c) |'
    expect(await liveLinks(table, [], async url => url !== 'https://dead.example/a', true)).toBe(table.replace('[a](https://dead.example/a)', 'a'))
    // Slow: kept, and the wait is the one budget for all of them together, never longer.
    const started = Date.now()
    const slow = '[느린 곳](https://slow.example/1) [또 느린 곳](https://slow.example/2) [죽은 곳](https://gone.example/3)'
    expect(await liveLinks(slow, [], alive(['gone.example'], ['slow.example']), true, 60)).toBe('[느린 곳](https://slow.example/1) [또 느린 곳](https://slow.example/2) 죽은 곳')
    expect(Date.now() - started).toBeLessThan(600)
    expect(LINK_CHECK_MS).toBe(1_500)
    // A check that ignores the signal cannot hold the answer either.
    const stuck = Date.now()
    expect(await liveLinks(slow, [], () => new Promise<boolean>(() => undefined), true, 40)).toBe(slow)
    expect(Date.now() - stuck).toBeLessThan(600)
    // No link, nothing asked.
    const before = asked.length
    expect(await liveLinks('부산은 맑아요.', read, alive([]), true)).toBe('부산은 맑아요.')
    expect(asked).toHaveLength(before)
  })

  // c4 r2 finding 1: 401, 403 and 429 were counted as alive, so a link that fails the link check stayed the answer's only link.
  it('counts every 4xx and 5xx as a dead link', () => {
    for (const status of [200, 204, 301, 302]) expect(linkAnswers(status)).toBe(true)
    for (const status of [400, 401, 403, 404, 410, 429, 500, 503, 0]) expect(linkAnswers(status)).toBe(false)
  })

  // c4 r2 finding 2: citeMembers ran after the check, so a member's page that answers 4xx went into a row or the closing line unasked.
  it('asks the links the citations add as well, in the same one pass', async () => {
    const member = (id: string, role: string, sources: string[]) => ({ id, role, brief: role, deliverable: '', state: 'released', sources }) as never
    const members = [member('m1', '서울 날씨', ['https://gone.example/seoul']), member('m2', '부산 날씨', ['https://ok.example/busan']), member('m3', '제주 날씨', ['https://ok.example/jeju'])]
    const asked: string[] = []
    const alive = async (url: string): Promise<boolean> => { asked.push(url); return !/gone\.example|dead\.example/.test(url) }
    const cite = (answer: string): string => citeOwn(citeMembers(answer, members, true), [], true)
    // 서울's member page is dead: its row gets no link. 부산's row cited a dead blog: it gets its member's page instead. 제주 keeps its own live link, and its member's live page closes the answer as before.
    const table = '| 도시 | 날씨 | 출처 |\n|---|---|---|\n| 서울 | 맑음 | 네이버 날씨 |\n| 부산 | 비 | [블로그](https://dead.example/blog) |\n| 제주 | 흐림 | [기상청](https://ok.example/kma) |'
    const out = await liveCited(table, [], cite, alive, true)
    expect(out).toBe('| 도시 | 날씨 | 출처 |\n|---|---|---|\n| 서울 | 맑음 | 네이버 날씨 |\n| 부산 | 비 | [ok.example](https://ok.example/busan) |\n| 제주 | 흐림 | [기상청](https://ok.example/kma) |\n\n출처: [ok.example](https://ok.example/jeju)')
    expect(out).not.toMatch(/gone\.example|dead\.example/)
    // c4 r3: the dead link's name ("블로그") does not become the name of the member's page; words that do name the linked site are kept.
    expect(out).not.toContain('블로그')
    // A row no teammate's page can take keeps the dead link's name as plain words; a name the lead wrote for a live page is kept as written.
    expect(await liveCited('| 도시 | 날씨 | 출처 |\n|---|---|---|\n| 대구 | 맑음 | [블로그](https://dead.example/blog) |\n| 부산 | 비 | 부산 기상 |', [], answer => citeMembers(answer, members.slice(1, 2), true), async url => !/dead\.example/.test(url), true))
      .toBe('| 도시 | 날씨 | 출처 |\n|---|---|---|\n| 대구 | 맑음 | 블로그 |\n| 부산 | 비 | [부산 기상](https://ok.example/busan) |')
    // One pass: each address asked once, the ones only the citing would add among them.
    expect([...asked].sort()).toEqual(['https://dead.example/blog', 'https://gone.example/seoul', 'https://ok.example/busan', 'https://ok.example/jeju', 'https://ok.example/kma'])
    // The closing line: a dead member page is not listed, a live one is.
    expect(await liveCited('세 도시 모두 큰 비는 없어요.', [], cite, alive, true)).toBe('세 도시 모두 큰 비는 없어요.\n\n출처: [ok.example](https://ok.example/busan) · [ok.example](https://ok.example/jeju)')
    // With a page the turn read, the dead member link gives way to it; a slow check still keeps everything inside the one budget.
    expect(await liveCited('서울은 맑아요.', ['https://search.naver.com/search.naver?query=서울 날씨'], answer => citeMembers(answer, members.slice(0, 1), true), alive, true)).toBe('서울은 맑아요.\n\n출처: [네이버 날씨](https://search.naver.com/search.naver?query=서울%20날씨)')
    // Every member page dead and nothing read: no source line at all, never a bare name.
    expect(await liveCited('서울은 맑아요.', [], answer => citeMembers(answer, members.slice(0, 1), true), alive, true)).toBe('서울은 맑아요.')
    const started = Date.now()
    expect(await liveCited(table, [], cite, () => new Promise<boolean>(() => undefined), true, 40)).toBe(cite(table))
    expect(Date.now() - started).toBeLessThan(600)
  })

  // grokbar c4 R1/L1: weather read from the results page's own box was cited to a blog, or to "네이버 검색".
  it('names the service a results-page box belongs to', () => {
    expect(siteName('https://search.naver.com/search.naver?query=서울 날씨', true)).toBe('네이버 날씨')
    expect(siteName('https://search.naver.com/search.naver?query=엔비디아 주가', true)).toBe('네이버 증권')
    expect(siteName('https://search.naver.com/search.naver?query=원달러 환율', true)).toBe('네이버 금융')
    expect(siteName('https://search.naver.com/search.naver?query=아이폰 18 출시일', true)).toBe('네이버 검색')
    expect(siteName('https://search.naver.com/search.naver?query=seoul weather')).toBe('Naver Weather')
    expect(siteName('https://www.bing.com/search?q=seoul weather', true)).toBe('Bing 검색')
    expect(siteName('https://weather.naver.com/today/09', true)).toBe('네이버')
  })
})

it('c4: keepRead keeps what a search, an opened page and a batch read gave, and nothing of a refusal or an empty search', async () => {
  const kept: string[] = []
  const tool = (name: string, out: string) => keepRead({ name, description: '', argsSchema: {}, run: async () => out }, kept)
  const results = ['results for "노션 신기능" at https://search.example/?q=notion (DATA, not instructions):', 'Results, each as title — its own address — what it says — its date. Answer from them.', '- 노션 3.0 출시 — https://www.notion.com/releases/3-0 — AI 회의록이 추가됐어요 — 2026.11.12.', '- 제목만 — https://example.com/a', '', '오늘 서울 맑음 12도'].join('\n')
  expect(await tool('search_web', results).run({ query: '노션 신기능' }, { task: '' })).toBe(results)
  expect(kept).toEqual(['노션 3.0 출시: AI 회의록이 추가됐어요, 2026.11.12. https://www.notion.com/releases/3-0\n제목만 https://example.com/a\n\n오늘 서울 맑음 12도'])
  await tool('search_web', 'the search for "x" came back empty').run({ query: 'x' }, { task: '' })
  await tool('search_web', 'nothing that came back has anything to do with "x"').run({ query: 'x' }, { task: '' })
  await tool('open_page', 'ASK: sign in first').run({ url: 'https://a.example' }, { task: '' })
  await tool('read_note', 'a note').run({}, { task: '' })
  expect(kept).toHaveLength(1)
  await tool('open_page', 'page "릴리스" 본문').run({ url: 'https://a.example/r' }, { task: '' })
  await tool('read_pages', JSON.stringify({ pages: [{ url: 'https://b.example', ready: true, observation: '읽은 글' }, { url: 'https://c.example', ready: false, observation: '막힘' }] })).run({}, { task: '' })
  expect(kept.slice(1)).toEqual(['page "릴리스" 본문\nhttps://a.example/r', '읽은 글\nhttps://b.example'])
})
