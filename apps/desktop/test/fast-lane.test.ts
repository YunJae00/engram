import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { fastLane, LANE_NOTE, LANE_SOLO_CALLS, LANE_SOLO_SOFT_MS, LANE_TEAM_CALLS, LANE_TOOLS, laneFirstLine, laneToday, quietRounds, quickQuestion, SHORT_QUESTION_NOTE, shortQuestion, SMALL_TALK_NOTE, teamAsk } from '../src/main/fast-lane.js'
import { PRELOADED_TOOLS_MAX } from '../src/main/engine-claude-session.js'

// grokbar BAR prompts, as typed.
const LANE = [
  '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘',
  '봇 3개 만들어서 서울 부산 제주 날씨 조사해줘',
  '아이폰 18, 갤럭시 S27, 픽셀 11 가격이랑 출시일 비교해줘. 각각 따로 조사시켜',
  '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘',
  '오늘 서울 날씨 어때?', '엔비디아 오늘 주가 알려줘', '이번 주말 부산 비 와?', '원달러 환율 지금 얼마야?',
  'Have three bots research the weather in Seoul, Busan and Jeju', "What's the weather in Seoul today?",
]
const NORMAL = [
  '안녕', '1년은 몇 초야?', '"회의 늦어서 죄송합니다"를 정중한 영어 이메일 한 줄로 써줘', '방금 말한 거 더 짧게',
  'fixtures/meeting-notes.md 회의록 요약해서 결정사항이랑 할 일 정리해줘', '위 회의록으로 워드 보고서 만들어줘', '다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적',
  'fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘', 'fixtures/inbox-dump 폴더 파일들 종류별로 정리해줘', '정리한 폴더에 PDF 몇 개야?',
  '내 이름은 권윤재고 지민호랑 같이 일해. 기억해', '아 지민호 말고 민호야', '지민 하나 추가해줘. 리서치 담당이야', '서연도 추가해줘. 카피 담당이야', '매주 월요일 아침 9시에 지난주 팀이 한 일 요약해줘', '서연은 빼고 지민은 이름을 지우로 바꿔',
  // Work given to a named agent is the team tools' (B2/B3), not this lane's.
  '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜', '이거 지민한테 맡겨: 다음 달 서울 IT 행사 일정 정리', '지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해',
  // A lookup that also asks for other work keeps every tool.
  '서울 날씨 조사해서 엑셀로 만들어줘', '엔비디아 주가 알려주고 메모에 저장해줘', '경쟁사 뉴스 찾아서 메일로 보내줘', '/skill 날씨', 'Research the news and write a report',
  // grokbar review r1: an app, a destination, a delivery or an output target is work the lane's menu cannot finish.
  '서울 날씨 조사해서 카카오톡으로 알려줘', '서울 날씨 조사해서 노션에 정리해줘', '서울 날씨 조사해서 카톡으로 보내줘', '엔비디아 주가 슬랙에 올려줘', '오늘 뉴스 조사해서 팀 채널에 공유해줘', '환율 검색해서 구글 시트에 넣어줘',
  '날씨 조사해서 문자로 알려줘', '뉴스 찾아서 블로그에 써줘', '주가 조사해서 민수에게 전달해줘', '날씨 알아봐서 클립보드에 복사해줘', '뉴스 검색해서 텔레그램으로 쏴줘', '날씨 조사해서 내 폰으로 알려줘', '뉴스 조사해서 인쇄해줘',
  '주가 조사해서 디스코드로 알려줘', '날씨 조사해서 트렐로 카드에 추가해줘', '봇 3개 만들어서 서울 부산 제주 날씨 조사해서 노션에 정리해줘',
  'Look up the weather and post it to Slack', 'Research the news and put it in Notion', 'Look up the stock price and text me', 'search for news and share it with the team',
]
// The way an answer is laid out is not a place to put it.
const FORM = ['서울 부산 제주 날씨 표로 정리해줘', '오늘 뉴스 한국어로 알려줘', '엔비디아 주가 한 줄로 알려줘', '환율 기준으로 정리해줘', '주말에 부산 날씨 알려줘', '서울 날씨 간단히 알려줘', 'Search for the news in Korean']

it('sends a web lookup or a bots-research ask to the fast lane, and nothing that hints at other work', () => {
  for (const message of [...LANE, ...FORM]) expect(fastLane(message, true), message).toBe(true)
  for (const message of NORMAL) expect(fastLane(message, true), message).toBe(false)
  // Not a plain ask (attachment, resumed or scheduled work, a check turn, another brain): never.
  for (const message of LANE) expect(fastLane(message, false), message).toBe(false)
  expect(fastLane(`서울 날씨 ${'가'.repeat(400)}`, true)).toBe(false)
})

it('keeps the lane menu small enough to be preloaded, with the team and reading tools', () => {
  // +1: a session with a browser adds collect_results.
  expect(LANE_TOOLS.size + 1).toBeLessThanOrEqual(14)
  expect(14).toBeLessThanOrEqual(PRELOADED_TOOLS_MAX)
  for (const name of ['hire_members', 'review_member', 'search_web', 'read_pages', 'ask_person']) expect(LANE_TOOLS.has(name), name).toBe(true)
  expect(LANE_NOTE).toContain('one table')
  expect(LANE_NOTE).toContain('source address in every row')
  // grokbar baseline R2: the lead redid two members and then went looking itself; the answer never came.
  expect(LANE_NOTE).toContain('do not redo a member and do not look up the missing parts yourself')
  // grokbar baseline R3 (U1): the lead opened a Korean thread with "I'll find recent Korean AI startup funding news".
  expect(LANE_NOTE).toContain('the lines before a tool call included, is in their language')
  expect(SMALL_TALK_NOTE).toContain('one or two short sentences')
})

it('tells a short question from a short job, so only the question is asked to be brief', () => {
  for (const message of ['1년은 몇 초야?', '정리한 폴더에 PDF 몇 개야?', '나 누구랑 일하지?', 'How many seconds in a year?']) expect(shortQuestion(message), message).toBe(true)
  for (const message of ['메일 써줘', '방금 말한 거 더 짧게', '소설 써줘', '이 계약서의 위험 요소를 전부 찾아서 표로 정리하고 각 항목마다 근거 조항을 달아줄 수 있어?', '첫 줄\n둘째 줄?']) expect(shortQuestion(message), message).toBe(false)
  expect(SHORT_QUESTION_NOTE).toContain('exact figures written out in digits')
})

it('runs the lane turn on the smart tier with the small menu and no shell, and hands mid-turn words to the running turn', () => {
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc).toContain('tools: lane ? everyTool.filter(tool => LANE_TOOLS.has(tool.name)).map(tool => keepSources(skipWalls(tool), read)) : deskMenu ? everyTool.filter(tool => deskMenu.has(tool.name)) : everyTool,')
  expect(ipc).toContain("...(lane ? { modelHint: 'smart' as const, lookup: true, ...(teamAsk(request.message) ? { maxCalls: LANE_TEAM_CALLS } : { maxCalls: LANE_SOLO_CALLS, deadlineMs: LANE_SOLO_SOFT_MS }) } : {}),")
  // The company lane is decided first and takes the turn; the fast lane never runs beside it, and neither has the shell.
  // A correction takes the route of the ask before it (desk-lane.ts routeAsk); any other message is routed by its own words.
  expect(ipc).toContain('const lane = !company && fastLane(routed, plainAsk)')
  expect(ipc).toContain('...(native && !lane && !company ? { native } : {}),')
  // grokbar c3: the host answers mid-turn words itself (aside-ipc), so the turn is told they were answered and writes no line of its own.
  expect(ipc).toContain('steerReplied: true, takeSteer: () => { const said = takeFollowUps(channel); steered.push(...said); return said }')
  expect(ipc).toContain('voice: channel => chatEngine(channel, ctx.engines),')
  expect(ipc).toContain('acknowledgeHanded(paths, bot.id, [...stored.pending, ...steered], checkpoint)')
  // A lookup asked before has a learned route as its context: it is still a plain ask (a daily "오늘 날씨" must not fall back to the slow path).
  expect(ipc).toContain('(!turn?.context || turn.learned === true)')
  expect(readFileSync(new URL('../src/main/task-runner.ts', import.meta.url), 'utf8')).toContain('playbook ? { context: playbookContext(playbook), learned: true } : undefined')
  expect(ipc).toContain('steered: followUpSaid')
  expect(ipc).toContain('stop: stopChat,')
  // grokbar Q1: a greeting the quick voice answered ends the turn there; the main model is not asked for a second one.
  expect(ipc).toContain('const greeted = turn?.context || request.attachments?.length ? undefined : await smallTalkAnswer(channel)')
  expect(ipc).toContain('if (greeted) { turnOutcomes.set(channel, { answer: greeted, asked: false, unfinished: false, steps: 0 }); await deliverAnswer(greeted); return }')
})

// grokbar B6 R3: the lead alone ran 14 searches over 128 s and wrote its first word at 128.5 s; L1 had no date; R1-R3 had no links.
it('bounds a lone lookup like a member, leaves a team turn to its members\' limits, and gives the turn today\'s date', () => {
  for (const message of LANE.slice(0, 3)) expect(teamAsk(message), message).toBe(true)
  for (const message of LANE.slice(3, 8)) expect(teamAsk(message), message).toBe(false)
  // First search by ~9 s, no new call after 12 s, then the answer: inside the 20 s of a single lookup.
  expect(LANE_SOLO_SOFT_MS).toBeLessThanOrEqual(12_000)
  expect(LANE_SOLO_CALLS).toBeLessThanOrEqual(4)
  // hire, a second hire for words said mid-turn, and a review for each of four members.
  expect(LANE_TEAM_CALLS).toBeGreaterThanOrEqual(6)
  expect(laneToday(new Date(2026, 10, 16, 21))).toContain('Today is 2026-11-16 (Monday).')
  // stack-1 L1 had no date and L3 no Saturday: the note gives the date in the person's own form and asks for each day by name.
  expect(laneToday(new Date(2026, 10, 16, 21))).toContain('11월 16일 월요일')
  expect(laneToday(new Date(2026, 10, 16, 21))).toContain('day by day')
  expect(LANE_NOTE).toContain('[site name](address)')
  expect(LANE_NOTE).toContain('never a site name alone')
  // grokbar B6 r2 (GROKBOT rule 1): the first line names the first concrete step; "바로 찾아볼게요." named none.
  expect(laneFirstLine('엔비디아 오늘 주가 알려줘', true)).toBe('지금 시세 확인할게요.')
  expect(laneFirstLine('오늘 서울 날씨 어때?', true)).toBe('지금 날씨 확인할게요.')
  expect(laneFirstLine('원달러 환율 지금 얼마야?', true)).toBe('지금 환율 확인할게요.')
  expect(laneFirstLine('오늘 AI 뉴스 5개 찾아줘', true)).toBe('최신 뉴스 검색할게요.')
  expect(laneFirstLine('봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합해줘', true)).toBe('봇들한테 나눠 맡길게요.')
  expect(laneFirstLine('아이폰 17 출시일 조사해줘', true)).toBe('웹에서 검색해 볼게요.')
  expect(laneFirstLine("what's the weather in Seoul?", false)).toBe('Checking the weather now.')
  for (const message of LANE) { expect(laneFirstLine(message, true), message).not.toMatch(/[A-Za-z]|찾아볼게요|알겠|네,/); expect(laneFirstLine(message, true), message).toMatch(/(확인|검색|맡길)/) }
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc).toContain("const laneNote = company ? '' : lane ? `${LANE_NOTE} ${laneToday()}` :")
  // A lookup cut at its limit is delivered as the answer it wrote (no English wrapper, no auto-continue), then every member's link is added.
  expect(ipc).toContain("if (result.stopped === 'calls' && !result.incomplete) { result.answer = cutShortAnswer(result.answer); delete result.stopped }")
  expect(ipc).toContain('result.answer = citeOwn(await team.cited(channel, result.answer), [...read], threadKorean(request.message, request.history ?? []))')
  expect(ipc.indexOf('team.cited(channel, result.answer)')).toBeLessThan(ipc.indexOf('turnOutcomes.set(channel, { tokensUsed'))
  expect(ipc).toContain('fastLane(request.message, true) ? { line: laneFirstLine(request.message, ')
  // Beside it, something the person only told gets its one line from the same voice (desk-lane.ts onlyTells).
  expect(ipc).toContain('whole: quickQuestion(request.message) }')
})

// grokbar B6 r2 Q2: "1년은 몇 초야?" had its first text at 2.7-4.3 s (the work model's first word).
it('lets the quick voice answer only a short question that needs nothing about the person, the thread, the company or the present', () => {
  for (const message of ['1년은 몇 초야?', '1마일은 몇 km야?', '물의 끓는점은 몇 도야?', 'How many seconds are in a year?']) expect(quickQuestion(message), message).toBe(true)
  for (const message of ['나 누구랑 일하지?', '내 일정 뭐 있어?', '김대리 누구야?', '다들 뭐하고 있어?', '원달러 환율 지금 얼마야?', '오늘 서울 날씨 어때?', '그럼 2년은?', '민호 전화번호 뭐야?', '이 파일 뭐야?', '오늘 며칠이야?', '1234 곱하기 5678은?', '1년은 몇 초야', '회의 늦어서 죄송합니다를 영어로 써줘', 'who is on my team?', ...LANE]) expect(quickQuestion(message), message).toBe(false)
})

// grokbar stack-1 R3: "Now I have solid sources for all 5 items. Let me verify the 뉴스1 엔비디아 article URL by reading it directly." was a bubble in a Korean thread.
it('shows a lookup turn\'s answer and its reply to mid-turn words, never the notes written between calls', () => {
  const shown: string[] = []
  const quiet = quietRounds(text => shown.push(text))
  // A note, then a tool call: never shown.
  quiet.token('Now I have solid sources for all 5 items. ', false)
  quiet.token('Let me verify the article URL by reading it directly.', false)
  expect(shown).toEqual([])
  // c3a review r2 #1: a note longer than 200 characters was taken for the answer and shown as it was written.
  const note = 'Now I have the search results for all three cities. Let me check each one against the weather service page before I write the table, since the first result looked a day old and the second one did not carry a date at all. Searching the web for results once more.'
  expect([...note].length).toBeGreaterThan(200)
  for (const piece of note.match(/[^]{1,40}/g)!) quiet.token(piece, false)
  expect(shown).toEqual([])
  // The answer is not streamed either; the delivered answer shows it (ipc deliverAnswer), so nothing is lost.
  quiet.token('지금 1달러에 1,385원이에요.', false)
  expect(shown).toEqual([])
  // A round marked aloud is shown as it comes.
  quiet.token('대구도 넣을게요.', true)
  expect(shown).toEqual(['대구도 넣을게요.'])
  // grokbar c3 T2: the reply to mid-turn words is the host's line now, so no round of a lookup is aloud: "알겠어요, 애플 주가로 알려드릴게요." was a second reply.
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc).toContain('if (quiet) quiet.token(text, false); else broadcast({ type: \'chat:token\', channel, text })')
  expect(ipc).toContain('onReset: (drop, tool) => { if (firstLineWaiting(channel)) return; broadcast(')
})

// grokbar c3: R2 ended "다시 시도해볼까요, 아니면 지금은 여기까지로 둘까요?", T2 said "시간이 다 돼서 이번 턴에서는…", R1 opened with
// "세 봇이 조사한 … 취합해서 알려드릴게요.", and L1-L4 read "수치와 출처를 나열… 검색 결과를 옮긴 듯".
it('asks a lookup for a colleague\'s short answer from the results, with no offer, no retry question and no failure report', () => {
  // One search, answered from the results list.
  expect(LANE_NOTE).toContain('one search_web is the normal case')
  expect(LANE_NOTE).toContain("answer from them and cite that result's own address")
  expect(LANE_NOTE).toContain('open a page (read_pages) only when a number they asked for is in none of them')
  expect(LANE_NOTE).toContain('exactly as many items as they asked for')
  // How it reads.
  expect(LANE_NOTE).toContain('lead with the answer in one sentence')
  expect(LANE_NOTE).toContain('at most two short sentences')
  expect(LANE_NOTE).toContain('leave out numbers they did not ask for')
  expect(LANE_NOTE).toContain('no "출처:" label line, no bare address on a line of its own')
  expect(LANE_NOTE).toContain('one friendly lead sentence that already gives the gist, with nothing after the table')
  // The merged answer of a team.
  expect(LANE_NOTE).toContain('never a status line about bots or collecting')
  expect(LANE_NOTE).toContain("the link text the site's name, never a member's role")
  expect(LANE_NOTE).toContain('"못 찾았어요"')
  // What is missing is said plainly; the answer never ends on a question, an offer or a failure report.
  expect(LANE_NOTE).toContain('"픽셀 11은 아직 공식 가격이 안 나왔어요"')
  expect(LANE_NOTE).toContain('This note overrides any rule that allows a closing offer or question')
  expect(LANE_NOTE).toContain('never ends on a question or an offer ("다시 시도해볼까요?", "더 찾아드릴까요?"')
  expect(LANE_NOTE).toContain('never reports a failure of your own')
  expect(LANE_NOTE).toContain('never speaks of time, limits, turns, attempts, tools or pages that did not open')
  // The old wording that asked for the opposite is gone.
  expect(LANE_NOTE).not.toContain('say in the answer what is missing.')
  expect(LANE_NOTE).not.toContain('answer in a few lines')
})
