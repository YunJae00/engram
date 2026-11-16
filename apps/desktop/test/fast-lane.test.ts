import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { fastLane, LANE_NOTE, LANE_TOOLS, SHORT_QUESTION_NOTE, shortQuestion, SMALL_TALK_NOTE } from '../src/main/fast-lane.js'
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
  '내 이름은 권윤재고 지민호랑 같이 일해. 기억해', '아 지민호 말고 민호야', '김대리 하나 뽑아줘. 리서치 담당이야', '매주 월요일 아침 9시에 마케팅팀 주간보고 올려',
  // Work given to a named employee is the company tools' (B2/B3), not this lane's.
  '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 보고해. 김대리, 박사원, 이과장한테 나눠서 시켜', '이거 김대리한테 맡겨: 다음 달 서울 IT 행사 일정 정리', '김대리 조사 끝나면 박사원한테 넘겨서 홍보 문구 3개 뽑게 해',
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
  expect(ipc).toContain('tools: lane ? everyTool.filter(tool => LANE_TOOLS.has(tool.name)) : everyTool,')
  expect(ipc).toContain("...(lane ? { modelHint: 'smart' as const } : {}),")
  expect(ipc).toContain('...(native && !lane ? { native } : {}),')
  expect(ipc).toContain('takeSteer: () => { const said = takeFollowUps(channel); steered.push(...said); return said }')
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
