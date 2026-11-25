const TEAM = /봇\s*(을|들|들을)?\s*(\d+\s*(개|명|마리)\s*)?(을|를)?\s*(생성|만들|써서|시켜|돌려|붙여)|팀원|(각각|따로|나눠서?)\s*(따로\s*)?(조사|검색|알아)|\b(bots?|agents?|team members?)\b[^.\n]*\b(research|look up|find|investigate)|\b(research|look up|investigate)\b[^.\n]*\bseparately\b/i
export const teamAsk = (message: string): boolean => TEAM.test(message)
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
