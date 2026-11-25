import { isOutsideAsk } from 'core'

const TEAM = /봇\s*(을|들|들을)?\s*(\d+\s*(개|명|마리)\s*)?(을|를)?\s*(생성|만들|써서|시켜|돌려|붙여)|팀원|(각각|따로|나눠서?)\s*(따로\s*)?(조사|검색|알아)|\b(bots?|agents?|team members?)\b[^.\n]*\b(research|look up|find|investigate)|\b(research|look up|investigate)\b[^.\n]*\bseparately\b/i
const LOOKUP = /날씨|기온|강수|비\s*(와|오|올)|눈\s*(와|오|올)|미세\s*먼지|주가|주식|시세|환율|뉴스|가격|출시일|조사|리서치|검색|찾아\s*(줘|봐)|알아\s*봐|\b(weather|forecast|stock price|share price|exchange rate|news|research|look up|search for)\b/i
const OTHER_WORK = /한테|에게|뽑아|채용|내보내|해고|승진|담당|맡겨|파일|폴더|문서|워드|엑셀|피피티|슬라이드|보고서|메일|보내|전송|올려|게시|저장|만들|작성|써\s*줘|예약|결제|구매|주문|삭제|지워|열어|실행|앱|화면|캘린더|일정|매일|매주|매달|노트|메모|기억|클릭|로그인|다운로드|\.(md|csv|pdf|docx?|xlsx?|pptx?|txt|hwp)\b|\b(files?|folders?|documents?|word|excel|ppt|powerpoint|slides?|report|e-?mail|send|post|save|create|make|write|draft|book|buy|order|delete|open|run|app|screen|calendar|schedule|every (day|week|month)|notes?|remember|click|sign in|download)\b/i
const TARGET = /카카오|카톡|노션|슬랙|디스코드|텔레그램|라인으로|문자|지메일|아웃룩|구글\s*(독스|시트|드라이브|닥스)|드라이브|트렐로|지라|컨플루언스|깃허브|트위터|인스타|페이스북|블로그|왓츠앱|팀즈|메신저|채널|공유|전달|알림|통보|등록|업로드|붙여|복사|클립보드|입력해|기록해|넣어|옮겨|남겨|적어|내보내|출력|인쇄|프린트|전화|(?<!(표|목록|리스트|줄|문장|문단|글|말|한국어|영어|일본어|중국어|우리말|숫자|순서|기준|위주|중심|식|별|대|개|위|아래|따|새|제대|그대|이대|바|스스|서|별도|실시간|최신순|날짜순)으?)로\s*(알려|보내|전달|공유|정리|요약|옮겨|넣어|올려|남겨|써|쏴)|(?<!중|안|전|후|내|때|뒤|밖|사이|주말|오늘|내일|아침|저녁|이번 주|다음 주|\d[일시월년분])에\s*(정리|요약|넣어|올려|남겨|기록|적어|써|붙여|추가|옮겨|입력|등록|알려)|\b(kakao(talk)?|notion|slack|discord|telegram|whatsapp|teams|sms|imessage|gmail|outlook|google (docs?|sheets?|drive)|trello|jira|confluence|github|twitter|instagram|facebook|blog|channel|share|forward|notify|message|text (me|him|her|them)|dm|upload|paste|copy|clipboard|export|print|call|log|record|add (it|this|them) to|put (it|this|them) (in|on|into)|(to|into|onto|via) (my|our|the) \w+)\b/i
export const teamAsk = (message: string): boolean => TEAM.test(message)
const FIRST_STEPS: [RegExp, string, string][] = [
  [/날씨|기온|강수|비\s*(와|오|올)|눈\s*(와|오|올)|미세\s*먼지|\b(weather|forecast)\b/i, '지금 날씨 확인할게요.', 'Checking the weather now.'],
  [/환율|\bexchange rate\b/i, '지금 환율 확인할게요.', 'Checking the exchange rate now.'],
  [/주가|주식|시세|\b(stock|share) price\b/i, '지금 시세 확인할게요.', 'Checking the price now.'],
  [/뉴스|\bnews\b/i, '최신 뉴스 검색할게요.', 'Searching the latest news now.'],
]
const ASK_TAIL = /\s*((좀\s*)?(알려|말해|찾아|검색해|정리해|조사해|알아\s?봐|보여|요약해|확인해|비교해)\s*(줘|줄래|주세요|줘요|봐|봐줘)?(요)?|어때(요)?|어떄|얼마(야|예요|에요|니|임|인지)?|뭐야|어떻게\s*(돼|되나요|될까)|있어|해줘)\s*[.!?？~\s]*$/
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
const SPLIT_INTO = ['둘로', '셋으로', '넷으로'], SPLIT_COUNT = /([2-4])\s*(개|곳|명|가지|군데|종)/
const splitLine = (message: string, korean: boolean): string => {
  if (/봇|\bbots?\b/i.test(message)) return korean ? '봇들한테 나눠 맡길게요.' : 'Splitting this across the bots now.'
  const into = SPLIT_INTO[Number(SPLIT_COUNT.exec(message)?.[1]) - 2]
  return korean ? into ? `${into} 나눠 알아볼게요.` : '나눠서 알아볼게요.' : 'Splitting this up to look into it now.'
}
export const laneFirstLine = (message: string, korean: boolean): string => { if (TEAM.test(message)) return splitLine(message, korean); const step = FIRST_STEPS.find(([words]) => words.test(message)); return korean ? step?.[1] ?? '웹에서 검색해 볼게요.' : step?.[2] ?? 'Searching the web now.' }
export const SMALL_TALK_NOTE = 'This message is small talk: reply in one or two short sentences the way a colleague would, with no tools. Never ask or offer help in any wording ("뭘 도와드릴까요", "도와드릴 일 있으면 말씀하세요"): a greeting gets a greeting ("안녕하세요! 좋은 아침이에요.").'
export const SHORT_QUESTION_NOTE = 'This is a short ask: give exactly what was asked, the answer first - a question gets one to three sentences with exact figures written out in digits (a figure that rests on a convention they did not give - a common or a leap year, a 30- or 31-day month, which exchange - names it in two or three words in the same sentence, "평년 기준으로 31,536,000초예요.", and never adds the other variant or an "윤년이면 …" clause), and a line or a name is given as just that, with at most a few words before it ("이렇게 쓰면 돼요."), never a sentence that restates the ask or says what you are about to write ("…한 줄 써드릴게요."), and nothing after it: no line on what it means, why it fits or how you chose it. A pick ("하나만 골라줘") is the thing itself and half a clause of why, the way a person says it ("칼국수 어때요? 쌀쌀하니까요."): for a menu a dish, never a kind of restaurant. A line they asked for in another language is led by those few words in their own language, on the same line ("이렇게 쓰면 돼요. I apologize for being late to the meeting."), so the reply is never the foreign line alone, and those words are not the ones your reply before this one opened with. Asked for one thing, give exactly one; asked for three, give three, each a short plain sentence, numbered when there are three or more. Recommendations for somewhere or something they told you about are each a thing of that place a person would name (a road, a museum, a market, a dish: "애월 해안도로 드라이브", "오설록 티뮤지엄"), never a kind of thing that would fit anywhere ("해안도로 드라이브", "실내 전시관 관람"), each with half a clause of why it fits what they told you ("차에서 내려 조금만 걸으면 돼요"), one short line each, in Korean words only ("드라이브", never "drive-through 느낌"); still no question back. No other variants, background or tips unless they ask. When they ask for it shorter, more polite or once more ("더 짧게", "더 정중하게", "다시"), change only that: what the earlier line means and its register stay ("I apologize for being late to the meeting." made shorter is "I apologize for being late.", not "Sorry I\'m running late."). A question about the person themselves (who they work with, where they live, what they do) is answered from what you know of them in one short, plain sentence the way a colleague would say it back, never with an ending that reads as telling them to do it, and with no word about remembering or looking it up. Answer from this conversation and what you know, fitting what they told you earlier about the thing asked; look something up only when they ask for current facts. When the ask points back at something said earlier ("그 여행", "거기", "그거", "아까 그"), the answer opens with one sentence that names it in the conversation\'s own words and, for picks, says what you went by ("제주 가시면 아버님 무릎 생각해서 덜 걷는 걸로 골랐어요.", never without the name), and you never ask which one they mean.'
export const shortQuestion = (message: string): boolean => { const text = message.trim(); return [...text].length <= 40 && !text.includes('\n') && /[?？]$/.test(text) }
const SHORT_ASK = /(써|적어|바꿔|골라|추천해|번역해|다듬어|줄여|지어|말해|설명해|알려|정해|뽑아)\s*(줘|줄래|주세요|줘요|봐)\s*[.!~]*$|더\s*(짧게|길게|간단히|간단하게|쉽게|정중하게|부드럽게|자연스럽게)|\b(write|rewrite|reword|translate|shorten|rephrase|recommend|suggest|pick|name)\b[^.\n]*$/i
const SHORT_ASK_MAX = 60
const SHORT_ASK_OUT = /파일|폴더|문서|워드|엑셀|피피티|슬라이드|보고서|회의록|\.(md|csv|pdf|docx?|xlsx?|pptx?|txt|hwp)(?![a-z])|[\w-]+\/[\w.-]+|한테|에게|보내|전송|올려|게시|저장|만들|예약|결제|구매|주문|삭제|지워|일정|매일|매주|매달|기억|팀원|봇|최신|요즘|오늘|지금|현재|\b(files?|folders?|documents?|word|excel|ppt|powerpoint|slides?|report|send|post|save|book|buy|order|delete|schedule|every (day|week|month)|remember|latest|current|today|now)\b/i
export const shortAsk = (message: string): boolean => { const text = message.trim(); return [...text].length <= SHORT_ASK_MAX && !text.includes('\n') && SHORT_ASK.test(text) && !isOutsideAsk(text) && ![SHORT_ASK_OUT, LOOKUP, TEAM].some(words => words.test(text)) }

const NEEDS_CONTEXT = /(^|\s)(나|난|내|내가|나는|나한테|저|전|제|제가|저는|우리|너|넌|네가|니가|당신|그럼|그러면|그거|그건|그게|이거|이건|이게|저거|아까|방금|다시|또|더)(?=\s|[?？]|$)|누구|누가|다들|직원|사원|대리|과장|차장|부장|팀|봇|님|번호|주소|연락처|생일|오늘|지금|현재|요즘|최근|올해|내일|어제|이번|다음|언제|몇\s*시|며칠|요일|어디|\b(i|me|my|mine|we|our|you|your|it|that|this|these|those|he|she|they|who|whose|where|when|today|now|current|currently|latest|recent|tomorrow|yesterday|again|more|team|bot)\b/i
export const quickQuestion = (message: string): boolean => shortQuestion(message) && (message.match(/\d{3,}/g) ?? []).length < 2 && ![NEEDS_CONTEXT, LOOKUP, OTHER_WORK, TARGET, TEAM].some(words => words.test(message))
