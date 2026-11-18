import { datedQuery, isOutsideAsk, periodSpans, withoutRelativeTime, type AgentTool } from 'core'
export const LANE_TOOLS = new Set(['hire_members', 'review_member', 'team_status', 'search_web', 'read_pages', 'open_page', 'read_open_page', 'search_memory', 'read_note', 'search_chats', 'ask_person'])

const TEAM = /봇\s*(을|들|들을)?\s*(\d+\s*(개|명|마리)\s*)?(을|를)?\s*(생성|만들|써서|시켜|돌려|붙여)|팀원|(각각|따로|나눠서?)\s*(따로\s*)?(조사|검색|알아)|\b(bots?|agents?|team members?)\b[^.\n]*\b(research|look up|find|investigate)|\b(research|look up|investigate)\b[^.\n]*\bseparately\b/i
const LOOKUP = /날씨|기온|강수|비\s*(와|오|올)|눈\s*(와|오|올)|미세\s*먼지|주가|주식|시세|환율|뉴스|가격|출시일|조사|리서치|검색|찾아\s*(줘|봐)|알아\s*봐|\b(weather|forecast|stock price|share price|exchange rate|news|research|look up|search for)\b/i
const OTHER_WORK = /한테|에게|뽑아|채용|내보내|해고|승진|담당|맡겨|파일|폴더|문서|워드|엑셀|피피티|슬라이드|보고서|메일|보내|전송|올려|게시|저장|만들|작성|써\s*줘|예약|결제|구매|주문|삭제|지워|열어|실행|앱|화면|캘린더|일정|매일|매주|매달|노트|메모|기억|클릭|로그인|다운로드|\.(md|csv|pdf|docx?|xlsx?|pptx?|txt|hwp)\b|\b(files?|folders?|documents?|word|excel|ppt|powerpoint|slides?|report|e-?mail|send|post|save|create|make|write|draft|book|buy|order|delete|open|run|app|screen|calendar|schedule|every (day|week|month)|notes?|remember|click|sign in|download)\b/i
const TARGET = /카카오|카톡|노션|슬랙|디스코드|텔레그램|라인으로|문자|지메일|아웃룩|구글\s*(독스|시트|드라이브|닥스)|드라이브|트렐로|지라|컨플루언스|깃허브|트위터|인스타|페이스북|블로그|왓츠앱|팀즈|메신저|채널|공유|전달|알림|통보|등록|업로드|붙여|복사|클립보드|입력해|기록해|넣어|옮겨|남겨|적어|내보내|출력|인쇄|프린트|전화|(?<!(표|목록|리스트|줄|문장|문단|글|말|한국어|영어|일본어|중국어|우리말|숫자|순서|기준|위주|중심|식|별|대|개|위|아래|따|새|제대|그대|이대|바|스스|서|별도|실시간|최신순|날짜순)으?)로\s*(알려|보내|전달|공유|정리|요약|옮겨|넣어|올려|남겨|써|쏴)|(?<!중|안|전|후|내|때|뒤|밖|사이|주말|오늘|내일|아침|저녁|이번 주|다음 주|\d[일시월년분])에\s*(정리|요약|넣어|올려|남겨|기록|적어|써|붙여|추가|옮겨|입력|등록|알려)|\b(kakao(talk)?|notion|slack|discord|telegram|whatsapp|teams|sms|imessage|gmail|outlook|google (docs?|sheets?|drive)|trello|jira|confluence|github|twitter|instagram|facebook|blog|channel|share|forward|notify|message|text (me|him|her|them)|dm|upload|paste|copy|clipboard|export|print|call|log|record|add (it|this|them) to|put (it|this|them) (in|on|into)|(to|into|onto|via) (my|our|the) \w+)\b/i
const ASK_MAX = 400

export const LANE_NOTE = [
  'Fast lookup turn: you have reading tools and a hidden team, nothing else.',
  'For one lookup, one search_web is the normal case, with the query in the person\'s language (a news ask is searched as news). The results come as a list - each with its title, its own address, what it says and its date - so answer from them and cite that result\'s own address; open a page (read_pages) only when a number they asked for is in none of them, and use at most two tool calls. A list they asked for (news, prices) is yours to pick from the results: as many items as they asked for, each a different event that is what they asked for (a statistic, a plan or an opinion piece that only touches the topic is not one), never two items about the same event, each one line with what happened, its date and its own article address as a named link, never a search page. When the results say how many of the asked number are here, that is the count: list them, and when it is fewer the lead says in one plain clause how many there are, in your own words. A news list is a numbered list (1. 2. 3.), one line per item, never a table, and nothing after the last item: no closing paragraph, no remark on an item. A short list asked in chat (three or fewer) reads the way a person passes news on: each item one plain sentence with the outlet as the link on its end, the date inside the sentence when it matters ("지난달 14일에"), never "sentence (date) — outlet". A longer list, or one asked to be put in order with its sources ("출처랑 같이 정리해줘"), keeps one line per item with what happened, its date and the outlet as a named link ([연합뉴스](address)). "올해" is never said over an item of another year. When the period they asked about ("요즘", "이번 주") holds fewer, the next most recent ones from the results marked older fill the list, each with its date and year, and the lead says so in half a sentence; never a word about what was left out. The items do not all end on one verb. A date is written as the results give it (11월 10일), never as an age ("1주 전").',
  'The answer reads like a colleague\'s message, not a search printout. Weather is told the way a person tells a colleague, in the plain present, opening on the day it is for with its date said plainly, never in brackets ("11월 17일 오늘은 비 오고 13도예요. 저녁까지 오다가 밤엔 그친대요."), a temperature in whole degrees when it ends in .0, and a weekend ask answered for 토요일 and 일요일 each by name ("토요일은 맑고, 일요일은 구름만 조금 껴요."), never in forecast endings ("-ㄹ 예정이에요", "-겠어요", "-ㄹ 전망이에요"), with one more line at most (the umbrella). A single lookup is the answer in one or two sentences plus at most one more line they would want (rain: take an umbrella), leading with the value asked, taken from a result or page that states it, never retold from a story only about it: no second paragraph, no extras such as a 52-week range, market value or related news, and no numbers they did not ask for. A price, a rate or a score says what it is as of in that first sentence ("11월 16일 종가 기준 155.26달러예요", "오늘 오후 2시 기준 1달러에 1,385원이에요"). That first sentence opens on what the figure is about, by the name the person used ("애플은 어제 종가 기준 …", "부산은 오늘 …"), always, and above all after they changed what they asked for. When they ask for today\'s or the current value and it is not out (the market is closed or has not opened, it is not published yet), the first sentence says why in a few words and gives the latest one ("미국 장이 아직 안 열려서 어제 종가 기준 156.14달러예요."). A figure read from the results page\'s own box (weather, a quote, a rate, a score) is cited to that service by name with the results page\'s address, the one after "results for … at" - [네이버 날씨](that address), [네이버 증권](that address) - never to a blog or any other result you did not take the figure from. The source is one named link inside or right after the last sentence, [site name](address) such as [네이버 날씨](address): no "출처:" label line, no bare address on a line of its own, never a site name alone. A source is named by its site or publication (삼성전자 뉴스룸, 연합뉴스); a post on a platform is named by the platform (네이버 블로그, 네이버 카페, 유튜브, 티스토리), never by the writer\'s id; a site whose name you do not know is named by the plain word 출처: never a piece of the page\'s title, never an address or a piece of one. A comparison of several items (a news list is not one) is one table under one friendly lead sentence that already gives the gist, with nothing after the table. When they compare named things on named points ("가격이랑 출시일 비교"), the table has one row per thing and one column per point, in the order they said them, then the source column; every cell is a short value, never a sentence, and never two points in one cell. Every value says what it is and whose it is: a thing already out has its 출시가 and its date, never "미발표"; a value not announced yet still gives the figure a colleague would give, labeled: the reported expectation ("미발표, 예상 130만 원대", "2027년 2월 예상"); a figure of anything other than exactly the named thing (another model or edition of it, the one before it) names what it belongs to ("상위 모델 출시가 199만 원부터", "전작 S26 출시가 115만 원"), and when the named thing has no figure of its own that closest real figure is given, labeled, beside what is known of the named thing; the number, with its currency, comes from a result or is the previous model\'s known launch price, labeled 예상 or 전작 as what it is, never a number of your own, and never a cell with no number in it ("전작보다 인상 예상" alone is not a price).',
  'When the person asks for bots, members or separate research of several items: one hire_members call with one lookup member per item, each with its query (the search words for that item, "아이폰 18 가격 출시일"), each brief one line (what to find, for where and when) and each deliverable one line, no notes. For a comparison every brief names the same points its row needs, in the person\'s words ("갤럭시 S27의 가격과 출시일"), and the deliverable asks for each as a short value with a figure (an expected or previous-model figure, labeled, when it is not announced). When they report, accept what came back (review_member ok true for any member not already accepted, all in one step): do not redo a member and do not look up the missing parts yourself. Then answer once: one lead sentence that gives the gist - never a status line about bots or collecting ("세 봇이 조사한 결과를 취합해서 알려드릴게요") and never a word about how the work was split or how many took part, "작업 중", a member id or a role label - then one table (for a comparison: one row per thing named as they named it ("아이폰 18", never a variant such as "아이폰 18 프로"; every concrete value a member reported stays in its row, labeled as the member labeled it, never dropped or turned into "미발표"), one column per point they named, short cells, never another product\'s figure in a cell), the source address in every row: a last cell holding a markdown link, [site name](address), the address copied exactly from the sources or result of the member for that row and the link text the site\'s name, never a member\'s role, never a site name alone; a member that found nothing keeps its row with a plain "못 찾았어요"; nothing after the table.',
  // c19a (cause H): the reader writes once; nothing rewrites its answer after it (stack-18's heldAnswer / weekendAnswer did, from other words than it read).
  'When the ask covers several days or several items, each one is answered by its own name in a clause of its own ("토요일은 맑고, 일요일은 오후에 비가 와요."), never lumped together ("주말 내내 맑아요"). While search results or opened pages are in hand, the answer is written from them, never a line that it could not get them.',
  'When something is not out yet or could not be found, give what was found and say what is missing in one plain clause, beside the reported or previous figure that stands in for it ("픽셀 11은 아직 공식 가격이 안 나와서 예상가를 적었어요").',
  'This note overrides any rule that allows a closing offer or question: this answer never ends on a question or an offer ("다시 시도해볼까요?", "더 찾아드릴까요?", "원하시면 이어서 찾아볼게요"), never reports a failure of your own ("실패", "확인하지 못했어요", "가져오지 못했어요", "확인되는 대로 다시 알려드릴게요": when search results came with the task or from a call, the answer is written from them) and never speaks of time, limits, turns, attempts, tools or pages that did not open. No extra sections, nothing they did not ask for. Every word the person sees, the lines before a tool call included, is in their language.',
].join(' ')
export const LANE_SOLO_CALLS = 4
export const LANE_SOLO_SOFT_MS = 12_000
export const LANE_TEAM_CALLS = 8
export const quietRounds = (show: (text: string) => void) => ({ token(text: string, aloud: boolean): void { if (aloud) show(text) } })
export const teamAsk = (message: string): boolean => TEAM.test(message)
const FIRST_STEPS: [RegExp, string, string][] = [
  [/날씨|기온|강수|비\s*(와|오|올)|눈\s*(와|오|올)|미세\s*먼지|\b(weather|forecast)\b/i, '지금 날씨 확인할게요.', 'Checking the weather now.'],
  [/환율|\bexchange rate\b/i, '지금 환율 확인할게요.', 'Checking the exchange rate now.'],
  [/주가|주식|시세|\b(stock|share) price\b/i, '지금 시세 확인할게요.', 'Checking the price now.'],
  [/뉴스|\bnews\b/i, '최신 뉴스 검색할게요.', 'Searching the latest news now.'],
]
const KIND_WORDS = ['날씨', '환율', '주가', ''] as const
const KIND_OWN = [/날씨|기온|강수(량)?|비\s*(와|오|올)[가-힣]*|눈\s*(와|오|올)[가-힣]*|미세\s*먼지/g, /환율/g, /주가|주식|시세/g, /뉴스|기사|소식/g]
const WEATHER_DAY: [RegExp, string][] = [[/주말/, '주말'], [/모레/, '모레'], [/내일/, '내일'], [/(이번|다음)\s?주/, '주간']]
const ASK_WORDS = /(\d{1,2}|한|두|세|네|다섯)\s*(개|건|가지|꼭지)\s*(만|씩|정도)?|출처(랑|와|도|하고)?\s*(같이|함께|포함해서?)?|링크(랑|와|도|하고)?\s*(같이|함께)?|(^|\s)(그냥|한번|좀|아|혹시|빨리|간단히|짧게)(?=\s|$)/g
const ASK_TAIL = /\s*((좀\s*)?(알려|말해|찾아|검색해|정리해|조사해|알아\s?봐|보여|요약해|확인해|비교해)\s*(줘|줄래|주세요|줘요|봐|봐줘)?(요)?|어때(요)?|어떄|얼마(야|예요|에요|니|임|인지)?|뭐야|어떻게\s*(돼|되나요|될까)|있어|해줘)\s*[.!?？~\s]*$/
const EVENT_WORDS: [RegExp, string][] = [[/투자(?!\s*(유치|받))/, '투자 유치']]
export function laneQuery(message: string, now = new Date()): { query: string; kind?: 'news' } | undefined {
  if (!/[가-힣]/.test(message)) return undefined
  const kind = FIRST_STEPS.findIndex(([words]) => words.test(message))
  let words = message.replace(/[?？!.,~"'“”]+/g, ' ')
  for (let before = ''; before !== words;) { before = words; words = words.replace(ASK_TAIL, ' ').trim() }
  words = withoutRelativeTime(datedQuery(words.replace(ASK_WORDS, ' '), message, now))
  if (kind >= 0) words = words.replace(KIND_OWN[kind]!, ' ')
  words = words.replace(/\s+/g, ' ').trim()
  if (words.length < 2) return undefined
  if (kind === 3) return { query: EVENT_WORDS.reduce((out, [event, named]) => out.replace(event, named), words), kind: 'news' }
  if (kind < 0) return { query: words }
  const day = kind === 0 ? WEATHER_DAY.find(([said]) => said.test(message))?.[1] : undefined
  return { query: [words, day, KIND_WORDS[kind]].filter(Boolean).join(' ') }
}
export type AsideShape = 'add' | 'replace' | 'remark' | 'question' | 'other'
const REPLACES = /바꿔|바꾸|바꿀|말고|대신|아니라|아니고|\b(instead|rather than|switch|change (it |that |this )?to|make (it|that) )\b/i
const ADDS = /추가|더해|포함|같이|도\s*(넣|해|찾|봐|알려|조사|알아|부탁)|[가-힣]도\s*[.!~]*$|\b(add|also|too|as well|include|plus)\b/i
const GRAMMAR = /^(?:아+|어+|음+|하+|헐|휴|에휴|아이고|와|오|근데|그런데|그래도|그냥|진짜|정말|너무|되게|엄청|완전|좀|조금|많이|왜|언제|얼마나|어떻게|아직|아직도|안|못|벌써|이제|지금|아까|계속|자꾸|또|다|빨리|천천히|오래|이렇게|그렇게|저렇게|이거|그거|저거|이게|그게|요|네|ㅠ+|ㅜ+|ㅋ+|ㅎ+|so|very|too|still|yet|now|why|how|when|it|its|this|that|is|are|you|thanks|thank|please|ok|okay|wow)$/i
const PREDICATE = /(?:[아어여해워와줘봐네요다지까니냐래려게고서며군나돼됐걸]|ㅠ+|ㅜ+|ㅋ+)$/
const REQUEST = /(?:줘|줘요|주세요|줄래|해|해요|봐|봐요)$/
const CASE_PARTICLE = /[가-힣]{2,}(?:으로|로|을|를|은|는|도|랑|이랑|하고|까지|부터|에서|만)$/
const askWords = (ask: string): string[] => ask.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 2)
function namesSomething(text: string, ask = ''): boolean {
  const asked = askWords(ask), words = text.toLowerCase().split(/[^\p{L}\p{N}ㄱ-ㅎㅏ-ㅣ]+/u).filter(Boolean).map(word => word.replace(/(?:이야|이에요|예요|야|이다|이지|이죠)$/, '') || word)
  return words.some((word, at) => {
    if (asked.some(one => one.startsWith(word) || word.startsWith(one) && word.length - one.length <= 2) || GRAMMAR.test(word)) return false
    if (CASE_PARTICLE.test(word) || /^[a-z0-9]/.test(word)) return true
    return at + 1 < words.length && REQUEST.test(words[at + 1]!) || !PREDICATE.test(word)
  })
}
export function asideShape(text: string, ask?: unknown): AsideShape {
  const named = namesSomething(text, typeof ask === 'string' ? ask : '')
  return REPLACES.test(text) && named || !!swapTarget(text) ? 'replace' : ADDS.test(text) ? 'add' : !named ? 'remark' : /[?？]\s*$/.test(text) ? 'question' : 'other'
}
const firstResults = (query: string, found: string): string => `Results of the search already run for you ("${query}"). When they hold what was asked, answer from them now; search once more in other words only when they do not. If the person changes what they ask for while you work, these results are for the old ask: search for the new one, and name what the answer is now about in its first sentence ("애플은 …").\n${found}`
export async function firstSearch(message: string, search: AgentTool | undefined, signal?: AbortSignal, now = new Date()): Promise<{ opening: string; calls: number; query?: string; found?: string }> {
  const words = search && laneQuery(message, now)
  const found = words ? await search.run(words, { task: message, steps: [], read: '', ...(signal ? { signal } : {}) }).catch(() => '') : ''
  return /^results for "/.test(found) ? { opening: firstResults(words!.query, found), calls: LANE_SOLO_CALLS - 1, query: words!.query, found } : { opening: '', calls: LANE_SOLO_CALLS }
}
const SWAPS = /[가-힣A-Za-z0-9]\s*(?:걸|거|것으)로(?:\s*(?:해|바꿔|줘|해\s?줘|부탁해|봐\s?줘))?요?[.!~\s]*$/
const SWAP_LEAD = /^(?:아+|어|음|그냥|그럼|아니|아니야|아니다|그거|그건|그거\s*말고)\s+/
const SWAP_TAIL = String.raw`\s*(?:(?:바꿔|바꾸|해)(?:서)?\s*(?:알려|봐|찾아|확인해|보여)?\s*(?:줘|줄래|주세요)?요?|봐\s*줘|봐|부탁해|알려\s*줘|줘)?\s*[.!~]*$`
const SWAP_NEW = [new RegExp(String.raw`(?:말고|대신(?:에)?|아니라|아니고)\s*,?\s*(.+?)\s*(?:걸로|거로|것으로|으로|로)?${SWAP_TAIL}`), new RegExp(String.raw`^(.+?)\s*(?:걸로|거로|것으로|으로|로)${SWAP_TAIL}`)]
const NOT_A_THING = /^(?:표|목록|리스트|한국어|영어|원화|달러|엔화|숫자|짧게|간단히|요약|오늘|내일|모레|어제|주말|이번\s*주|다음\s*주|지난\s*주|[월화수목금토일]요일|\d+\s*(?:일|월|시|개|건))$/
function swapTarget(said: string): string | undefined {
  if (!REPLACES.test(said) && !SWAPS.test(said.trim()) && !/(?:으로|로)\s*해\s*(?:줘|줄래|주세요)?요?[.!~\s]*$/.test(said)) return undefined
  let text = said.trim()
  for (let before = ''; before !== text;) { before = text; text = text.replace(SWAP_LEAD, '') }
  const named = SWAP_NEW.map(words => words.exec(text)?.[1]?.trim()).find(Boolean)
  return !named || [...named].length > 20 || NOT_A_THING.test(named) || ASK_TAIL.test(named) ? undefined : named
}
export function swappedAsk(ask: string, said: string, now = new Date()): string | undefined {
  const named = swapTarget(said)
  if (!named) return undefined
  const kind = FIRST_STEPS.findIndex(([words]) => words.test(ask)), subject = subjectOf(ask, now)
  if (!subject || subject === named) return undefined
  return ask.includes(subject) ? ask.replace(subject, named) : `${named} ${kind >= 0 && kind < 3 ? KIND_WORDS[kind] : ''} 알려줘`.replace(/\s+/g, ' ')
}
function subjectOf(ask: string, now = new Date()): string | undefined {
  const old = laneQuery(ask, now), kind = FIRST_STEPS.findIndex(([words]) => words.test(ask))
  return old && (kind >= 0 && kind < 3 ? old.query.replace(new RegExp(`\\s*(?:${KIND_WORDS[kind]}|${WEATHER_DAY.map(([, day]) => day).join('|')})$`), '').replace(/\s*(?:주말|모레|내일|주간)$/, '') : old.query).trim() || undefined
}
const OTHER_NAMES: [RegExp, RegExp][] = [[/애플/, /apple|aapl/i], [/엔비디아/, /nvidia|nvda/i], [/테슬라/, /tesla|tsla/i], [/삼성전자/, /삼성|samsung|005930/i], [/마이크로소프트/, /마소|microsoft|msft/i], [/구글|알파벳/, /구글|알파벳|google|alphabet|googl/i], [/아마존/, /amazon|amzn/i], [/메타/, /meta|페이스북/i], [/SK하이닉스|하이닉스/, /하이닉스|hynix/i]]
export function namesSubject(answer: string, ask: string, now = new Date()): string {
  const subject = subjectOf(ask, now), body = answer.trimStart()
  if (!subject || !body) return answer
  const end = /[.!?。](?=\s|$)|\n/.exec(body)?.index ?? body.length, first = body.slice(0, end)
  const other = OTHER_NAMES.find(([own]) => own.test(subject))?.[1]
  if (first.toLowerCase().includes(subject.toLowerCase()) || other?.test(first)) return answer
  const last = subject.charCodeAt(subject.length - 1), topic = last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 ? '은' : '는'
  return `${subject}${topic} ${body}`
}
export function swapRounds(ask: string, turn: AbortSignal) {
  let stop = new AbortController(), to: string | undefined
  const signal = (): AbortSignal => AbortSignal.any([turn, stop.signal])
  return {
    signal,
    ask: (): string => ask,
    change(said: string): boolean { const next = swappedAsk(to ?? ask, said); if (!next) return false; to = next; stop.abort(); return true },
    async run<T>(round: (ask: string, signal: AbortSignal, again: boolean) => Promise<T>): Promise<T> {
      for (;;) {
        const again = !!to
        if (to) { ask = to; to = undefined; stop = new AbortController() }
        try { return await round(ask, signal(), again) } catch (error) { if (turn.aborted || !to) throw error }
      }
    },
  }
}
export const laneTidy = (answer: string): string => answer.replace(/(\d)\.0(?=\s*(?:도|℃|°))/g, '$1').replace(/(오늘|내일|모레)\s*\(((?:\d{1,2}월\s*)?\d{1,2}일)(?:\s*,?\s*[월화수목금토일](?:요일)?)?\)/g, '$2 $1')
const SPLIT_INTO = ['둘로', '셋으로', '넷으로'], SPLIT_COUNT = /([2-4])\s*(개|곳|명|가지|군데|종)/
const splitLine = (message: string, korean: boolean): string => {
  if (/봇|\bbots?\b/i.test(message)) return korean ? '봇들한테 나눠 맡길게요.' : 'Splitting this across the bots now.'
  const into = SPLIT_INTO[Number(SPLIT_COUNT.exec(message)?.[1]) - 2]
  return korean ? into ? `${into} 나눠 알아볼게요.` : '나눠서 알아볼게요.' : 'Splitting this up to look into it now.'
}
export const laneFirstLine = (message: string, korean: boolean): string => { if (TEAM.test(message)) return splitLine(message, korean); const step = FIRST_STEPS.find(([words]) => words.test(message)); return korean ? step?.[1] ?? '웹에서 검색해 볼게요.' : step?.[2] ?? 'Searching the web now.' }
// c19a (cause H, L3: "11월 18일 오늘이 수요일이라 이번 주말은 …" opened a weekend answer, because this line asked the reader to go "day by
// day, each day named with its date" and left the dates for it to work out): the host gives the dates the ask's relative days resolve to,
// from the calendar (periodSpans, the one date parser, and the weekday names), as facts to label the answer with, never to explain.
const WEEKDAYS = '일월화수목금토'
const koDay = (at: Date): string => `${at.getMonth() + 1}월 ${at.getDate()}일 ${WEEKDAYS[at.getDay()]}요일`
export function askedDays(ask: string, now = new Date()): [string, string][] {
  const day = (from: Date, offset: number): Date => new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset)
  const spans = periodSpans(ask, now).filter(span => span.to.getTime() - span.from.getTime() < 7 * 86_400_000), out: [string, string][] = []
  for (const [words, name, offset] of [[/오늘|\btoday\b/i, '오늘', 0], [/모레/, '모레', 2]] as const) if (words.test(ask)) out.push([name, koDay(day(now, offset))])
  const week = spans.find(span => /주$/.test(span.name)), named = [...new Set([...ask.matchAll(/([월화수목금토일])요일/g)].map(one => one[1]!))]
  for (const span of spans) {
    if (span === week && named.length) continue
    const days = Math.round((span.to.getTime() - span.from.getTime()) / 86_400_000)
    out.push([span.name, days <= 1 ? Array.from({ length: days + 1 }, (_, i) => koDay(day(span.from, i))).join(', ') : `${koDay(span.from)} ~ ${koDay(span.to)}`])
  }
  // A weekday is the one in the week the ask names, else the next one from today (today included).
  for (const name of named) { const at = week ? day(week.from, (WEEKDAYS.indexOf(name) + 6) % 7) : day(now, (WEEKDAYS.indexOf(name) - now.getDay() + 7) % 7); out.push([`${week ? `${week.name} ` : ''}${name}요일`, koDay(at)]) }
  return out
}
export const laneToday = (ask = '', now = new Date()): string => {
  const days = askedDays(ask, now)
  return `Today is ${now.toLocaleDateString('sv-SE')} (${now.toLocaleDateString('en-US', { weekday: 'long' })}), in Korean ${koDay(now)}.${days.length ? ` The days this ask names are: ${days.map(([name, at]) => `${name} = ${at}`).join('; ')}.` : ''} These dates are facts to label the answer with, the way the person writes dates ("토요일(11월 21일)은 …", "11월 19일 내일은 …"): never say how a date was worked out, never open on today's date or the day of the week, and never a sentence that only explains which days are meant.`
}
export const SMALL_TALK_NOTE = 'This message is small talk: reply in one or two short sentences the way a colleague would, with no tools. Never ask or offer help in any wording ("뭘 도와드릴까요", "도와드릴 일 있으면 말씀하세요"): a greeting gets a greeting ("안녕하세요! 좋은 아침이에요.").'
export const SHORT_QUESTION_NOTE = 'This is a short ask: give exactly what was asked, the answer first - a question gets one to three sentences with exact figures written out in digits (a figure that rests on a convention they did not give - a common or a leap year, a 30- or 31-day month, which exchange - names it in two or three words in the same sentence, "평년 기준으로 31,536,000초예요.", and never adds the other variant or an "윤년이면 …" clause), and a line or a name is given as just that, with at most a few words before it ("이렇게 쓰면 돼요."), never a sentence that restates the ask or says what you are about to write ("…한 줄 써드릴게요."), and nothing after it: no line on what it means, why it fits or how you chose it. A pick ("하나만 골라줘") is the thing itself and half a clause of why, the way a person says it ("칼국수 어때요? 쌀쌀하니까요."): for a menu a dish, never a kind of restaurant. A line they asked for in another language is led by those few words in their own language, on the same line ("이렇게 쓰면 돼요. I apologize for being late to the meeting."), so the reply is never the foreign line alone, and those words are not the ones your reply before this one opened with. Asked for one thing, give exactly one; asked for three, give three, each a short plain sentence, numbered when there are three or more. Recommendations for somewhere or something they told you about are each a thing of that place a person would name (a road, a museum, a market, a dish: "애월 해안도로 드라이브", "오설록 티뮤지엄"), never a kind of thing that would fit anywhere ("해안도로 드라이브", "실내 전시관 관람"), each with half a clause of why it fits what they told you ("차에서 내려 조금만 걸으면 돼요"), one short line each, in Korean words only ("드라이브", never "drive-through 느낌"); still no question back. No other variants, background or tips unless they ask. When they ask for it shorter, more polite or once more ("더 짧게", "더 정중하게", "다시"), change only that: what the earlier line means and its register stay ("I apologize for being late to the meeting." made shorter is "I apologize for being late.", not "Sorry I\'m running late."). A question about the person themselves (who they work with, where they live, what they do) is answered from what you know of them in one short, plain sentence the way a colleague would say it back, never with an ending that reads as telling them to do it, and with no word about remembering or looking it up. Answer from this conversation and what you know, fitting what they told you earlier about the thing asked; look something up only when they ask for current facts. When the ask points back at something said earlier ("그 여행", "거기", "그거", "아까 그"), the answer opens with one sentence that names it in the conversation\'s own words and, for picks, says what you went by ("제주 가시면 아버님 무릎 생각해서 덜 걷는 걸로 골랐어요.", never without the name), and you never ask which one they mean.'
export const shortQuestion = (message: string): boolean => { const text = message.trim(); return [...text].length <= 40 && !text.includes('\n') && /[?？]$/.test(text) }
const SHORT_ASK = /(써|적어|바꿔|골라|추천해|번역해|다듬어|줄여|지어|말해|설명해|알려|정해|뽑아)\s*(줘|줄래|주세요|줘요|봐)\s*[.!~]*$|더\s*(짧게|길게|간단히|간단하게|쉽게|정중하게|부드럽게|자연스럽게)|\b(write|rewrite|reword|translate|shorten|rephrase|recommend|suggest|pick|name)\b[^.\n]*$/i
const SHORT_ASK_MAX = 60
const SHORT_ASK_OUT = /파일|폴더|문서|워드|엑셀|피피티|슬라이드|보고서|회의록|\.(md|csv|pdf|docx?|xlsx?|pptx?|txt|hwp)(?![a-z])|[\w-]+\/[\w.-]+|한테|에게|보내|전송|올려|게시|저장|만들|예약|결제|구매|주문|삭제|지워|일정|매일|매주|매달|기억|팀원|봇|최신|요즘|오늘|지금|현재|\b(files?|folders?|documents?|word|excel|ppt|powerpoint|slides?|report|send|post|save|book|buy|order|delete|schedule|every (day|week|month)|remember|latest|current|today|now)\b/i
export const shortAsk = (message: string): boolean => { const text = message.trim(); return [...text].length <= SHORT_ASK_MAX && !text.includes('\n') && SHORT_ASK.test(text) && !isOutsideAsk(text) && ![SHORT_ASK_OUT, LOOKUP, TEAM].some(words => words.test(text)) }

const NEEDS_CONTEXT = /(^|\s)(나|난|내|내가|나는|나한테|저|전|제|제가|저는|우리|너|넌|네가|니가|당신|그럼|그러면|그거|그건|그게|이거|이건|이게|저거|아까|방금|다시|또|더)(?=\s|[?？]|$)|누구|누가|다들|직원|사원|대리|과장|차장|부장|팀|봇|님|번호|주소|연락처|생일|오늘|지금|현재|요즘|최근|올해|내일|어제|이번|다음|언제|몇\s*시|며칠|요일|어디|\b(i|me|my|mine|we|our|you|your|it|that|this|these|those|he|she|they|who|whose|where|when|today|now|current|currently|latest|recent|tomorrow|yesterday|again|more|team|bot)\b/i
export const quickQuestion = (message: string): boolean => shortQuestion(message) && (message.match(/\d{3,}/g) ?? []).length < 2 && ![NEEDS_CONTEXT, LOOKUP, OTHER_WORK, TARGET, TEAM].some(words => words.test(message))

export function fastLane(message: string, plain: boolean): boolean {
  const text = message.trim()
  if (!plain || !text || [...text].length > ASK_MAX || text.startsWith('/')) return false
  const team = TEAM.exec(text)
  const rest = team ? text.replace(team[0], ' ') : text
  if (OTHER_WORK.test(rest) || TARGET.test(rest) || isOutsideAsk(rest)) return false
  return !!team || LOOKUP.test(text)
}
