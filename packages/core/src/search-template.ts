import { siteOf } from './search-links.js'

export function deriveSearchTemplate(pasted: string, terms?: string): string | null {
  let url: URL
  try {
    url = new URL(pasted.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const params = [...url.searchParams.entries()]
  if (params.length === 0) return null
  const wanted = terms?.trim().toLowerCase()
  const named = wanted ? params.find(([, value]) => value.trim().toLowerCase() === wanted) : undefined
  const longest = params.reduce((best, one) => (one[1].length > best[1].length ? one : best), params[0]!)
  const chosen = named ?? longest
  if (chosen[1].trim().length < 2) return null
  url.searchParams.set(chosen[0], '{q}')
  return url.toString().replace('%7Bq%7D', '{q}')
}

export const defaultSearchTemplate = (query: string): string => /[가-힣]/.test(query) ? 'https://search.naver.com/search.naver?query={q}' : 'https://www.bing.com/search?q={q}'

export function searchUrlFor(template: string, query: string): string | null {
  if (!template.includes('{q}')) return null
  const filled = template.replace('{q}', encodeURIComponent(query))
  try {
    const url = new URL(filled)
    return url.protocol === 'http:' || url.protocol === 'https:' ? filled : null
  } catch {
    return null
  }
}

export function resultLinks(links: { text: string; url: string }[], from?: string): { text: string; url: string }[] {
  let page: URL | null = null
  try {
    page = from ? new URL(from) : null
  } catch {
    page = null
  }
  const out: { text: string; url: string }[] = []
  for (const link of links) {
    let url: URL
    try {
      url = new URL(link.url)
    } catch {
      continue
    }
    const behind = url.searchParams.get('uddg') ?? unwrapBingLink(url)
    if (behind) {
      out.push({ text: link.text, url: behind })
      continue
    }
    if (page && url.host === page.host && (url.searchParams.has('q') || url.pathname === page.pathname)) continue
    out.push(link)
  }
  return out
}

function unwrapBingLink(url: URL): string | null {
  const packed = url.pathname === '/ck/a' ? url.searchParams.get('u') : null
  if (!packed || !packed.startsWith('a1')) return null
  try {
    const decoded = Buffer.from(packed.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return /^https?:\/\//.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

interface SearchResult { title: string; url: string; snippet: string; date: string }
const NEW_WINDOW = /\s*(새\s?창\s?열림|opens? in (a )?new (window|tab))\s*/gi
const AD_HOST = /(^|\.)(ad|ads|ader|adcr|adclick|saedu|doubleclick|googleadservices|googlesyndication)\./i
const SHOWN_DATE = /\d+\s*(?:분|시간|일|주|개월|달|년)\s*전|어제|그저께|\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\.?|\d{4}년\s*\d{1,2}월\s*\d{1,2}일|\d{4}-\d{2}-\d{2}|\d+\s*(?:minutes?|mins?|hours?|days?|weeks?|months?|years?)\s+ago|\byesterday\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4}/gi
const RESULT_SNIPPET = 160
const AGO = /(\d+)\s*(분|시간|일|주|개월|달|년)\s*전|(\d+)\s*(minute|min|hour|day|week|month|year)s?\s+ago|(그저께|어제|\byesterday\b)/gi
const AGO_MINUTES: Record<string, number> = { 분: 1, minute: 1, min: 1, 시간: 60, hour: 60, 일: 1440, day: 1440, 주: 10080, week: 10080 }
export function calendarDates(text: string, now = new Date(), words = true, korean?: boolean): string {
  return text.replace(AGO, (whole: string, n?: string, unit?: string, n2?: string, unit2?: string, word?: string) => {
    if (word && !words) return whole
    const at = new Date(now), count = Number(n ?? n2 ?? (word === '그저께' ? 2 : 1)), per = (unit ?? unit2 ?? '일').toLowerCase()
    if (/개월|달|month/.test(per)) { at.setMonth(at.getMonth() - count); if (at.getDate() !== now.getDate()) at.setDate(0) }
    else if (/년|year/.test(per)) { at.setFullYear(at.getFullYear() - count); if (at.getDate() !== now.getDate()) at.setDate(0) }
    else at.setTime(at.getTime() - count * AGO_MINUTES[per]! * 60_000)
    const sameYear = at.getFullYear() === now.getFullYear()
    return (korean ?? /[가-힣]/.test(whole)) ? `${sameYear ? '' : `${at.getFullYear()}년 `}${at.getMonth() + 1}월 ${at.getDate()}일` : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
  })
}
export function searchResults(links: { text: string; url: string }[], text: string, query: string, from?: string, cap = 8, now = new Date()): SearchResult[] {
  let page: URL | null = null
  try { page = from ? new URL(from) : null } catch { page = null }
  const korean = /[가-힣]/.test(query) || undefined
  const groups = new Map<string, string[]>()
  for (const link of resultLinks(links, from)) {
    let url: URL
    try { url = new URL(link.url) } catch { continue }
    if (!/^https?:$/.test(url.protocol) || AD_HOST.test(url.host)) continue
    if (page && siteOf(url.host) === siteOf(page.host) && url.pathname.length <= 1) continue
    if (page && url.host === page.host && url.pathname === '/ck/a') continue
    const label = link.text.replace(NEW_WINDOW, ' ').replace(/\s+/g, ' ').trim()
    url.hash = ''
    if (label) groups.set(url.href, [...(groups.get(url.href) ?? []), label])
  }
  const words = query.toLowerCase().split(/[\s,./?!]+/).filter(word => word.length > 1)
  const dateOf = (value: string): string => value.match(SHOWN_DATE)?.at(-1) ?? ''
  const scored = [...groups].flatMap(([url, labels], order) => {
    const isDate = (label: string): boolean => label.length <= 24 && !!dateOf(label)
    const titles = labels.filter(label => !isDate(label) && !/https?:\/\/|›/.test(label) && label.length >= 4)
    const title = titles[0]
    if (!title) return []
    const at = text.indexOf(title.slice(0, 60))
    const own = titles.find(label => label !== title && label.length > 40)
    const after = at < 0 ? '' : text.slice(at + title.length, at + title.length + RESULT_SNIPPET).replace(NEW_WINDOW, ' ').trim().split('\n').slice(0, 2).join(' ')
    const snippet = (own ?? after).replace(/\s+/g, ' ').trim().slice(0, RESULT_SNIPPET)
    const date = dateOf(labels.find(isDate) ?? '') || (own ? '' : after.match(SHOWN_DATE)?.[0] ?? '') || (at < 0 ? '' : dateOf(text.slice(Math.max(0, at - 120), at)))
    const hay = `${title} ${own ?? ''} ${url}`.toLowerCase()
    const hits = words.filter(word => (isLatin(word) ? hay.includes(word) : gluedWord(word, hay))).length
    return [{ result: { title: title.slice(0, 120), url, snippet: calendarDates(snippet, now, false, korean), date: calendarDates(date, now, true, korean) }, hits, score: hits * 100 + Math.min(title.length, 60) - order / 100 }]
  })
  const echoing = scored.filter(one => one.hits > 0)
  const seen = new Set<string>(), lead: typeof scored = []
  for (const one of (echoing.length >= 3 ? echoing : scored).sort((a, b) => b.score - a.score)) { const site = siteKey(one.result.url); if (!seen.has(site)) lead.push(one); seen.add(site) }
  const sinks = (one: typeof scored[number]): number => Number(communityPost(one.result.url) || VIDEO_POST.test(one.result.url))
  return lead.sort((a, b) => sinks(a) - sinks(b)).slice(0, cap).map(one => one.result)
}
const siteKey = (url: string): string => new URL(url).hostname.replace(/^(www|m)\./, '')
const COMMUNITY = /(^|\.)(blog\.naver\.com|cafe\.naver\.com|post\.naver\.com|tistory\.com|brunch\.co\.kr|dcinside\.com|clien\.net|fmkorea\.com|ppomppu\.co\.kr|velog\.io|medium\.com)$/
const VIDEO_POST = /^https?:\/\/(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|tv\.naver\.com|tiktok\.com)\//i
export const communityPost = (url: string): boolean => { try { return COMMUNITY.test(siteKey(url)) } catch { return false } }

export const NEWS_ASK = /뉴스|기사|속보|보도\s?자료|헤드라인|\b(news|headlines?)\b/i
export function newsTemplate(template: string, period?: NewsPeriod): string {
  try {
    const url = new URL(template.replace('{q}', 'QQ'))
    if (url.host !== 'search.naver.com') return template
    url.searchParams.set('where', 'news')
    if (period) url.searchParams.set('nso', `so:r,p:${{ day: '1d', week: '1w', month: '1m', quarter: '3m', year: '1y' }[period]},a:all`)
    return url.toString().replace('QQ', '{q}')
  } catch { return template }
}
type NewsPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year'
const PERIODS: [RegExp, NewsPeriod][] = [[/오늘|\btoday\b/i, 'day'], [/이번\s?주|금주|\bthis week\b/i, 'week'], [/요즘|요새|최근|이번\s?달|\b(recent|recently|lately|these days|this month)\b/i, 'month']]
const PERIOD_DAYS: Record<NewsPeriod, number> = { day: 1, week: 7, month: 31, quarter: 92, year: 366 }
export const newsPeriod = (ask: string): NewsPeriod | undefined => PERIODS.find(([words]) => words.test(ask))?.[1]
const PERIOD_LEAD_MS = 86_400_000
export function periodSince(from: Date, now = new Date()): NewsPeriod {
  const days = (now.getTime() - from.getTime() + PERIOD_LEAD_MS) / 86_400_000
  return (['day', 'week', 'month', 'quarter', 'year'] as const).find(period => PERIOD_DAYS[period] >= days) ?? 'year'
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
export function resultDay(date: string, now = new Date()): Date | null {
  const dot = /(\d{4})(?:\.\s?|-)(\d{1,2})(?:\.\s?|-)(\d{1,2})/.exec(date), ko = /(?:(\d{4})년\s*)?(\d{1,2})월\s*(?:[^\d\n]{0,8}?(?:\d{1,2}\s*[~\-–]\s*))?(\d{1,2})일/.exec(date), en = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:,? (\d{4}))?/i.exec(date)
  const [year, month, day] = dot ? [dot[1], Number(dot[2]), dot[3]] : ko ? [ko[1], Number(ko[2]), ko[3]] : en ? [en[3], MONTHS.indexOf(en[1]!.toLowerCase()) + 1, en[2]] : []
  if (!month || !day) return null
  const at = new Date(Number(year ?? now.getFullYear()), month - 1, Number(day))
  if (!year && at.getTime() > now.getTime() + 86_400_000) at.setFullYear(at.getFullYear() - 1)
  return at
}
export function inPeriod(date: string, period: NewsPeriod, now = new Date()): boolean {
  const at = resultDay(date, now)
  return !at || at.getTime() >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - PERIOD_DAYS[period]).getTime()
}
export function datedWithYear(date: string, now = new Date()): string {
  const at = /\d{4}/.test(date) ? null : resultDay(date, now)
  return !at ? date : /월/.test(date) ? `${at.getFullYear()}년 ${date}` : `${date}, ${at.getFullYear()}`
}
const PARTICLE = /(한다|했다|된다|됐다|으로|에서|에도|에게|까지|부터|이|가|은|는|을|를|의|에|와|과|도|로)$/
const NEWS_WORD = /^(투자|유치|발표|공개|계획|추가|규모|시리즈\w*|라운드|단독|종합|속보|국내|한국|해외|글로벌|스타트업|기업|업체|회사|올해|내년|최대|신규|완료|성공|확대|진출|체결|내역|펀드|시드|프리\w*|브릿지|엔젤|후속|전략적?|주도|참여|단행|마무리|자금|조달|뉴스|기사|관련|기술|협력|강화|추진|한다|논란|기반|사업|서비스|개발|지원|시장|산업|플랫폼|솔루션|인공지능|ai|news|startups?|funding|raises?|invest\w*|series|round|seed|pre|bridge|angel|follow|million|billion|korean?)$/i
const nameWords = (text: string): string[] => [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).map(word => word.length >= 3 ? word.replace(PARTICLE, '') : word).filter(word => word.length >= 2 && !/^\d/.test(word) && !NEWS_WORD.test(word)))]
const alike = (a: string, b: string): boolean => a === b || Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))
const amounts = (title: string): string[] => (title.match(/\d[\d,.]*\s*(?:억|조|만\s*달러|million|billion)/gi) ?? []).map(one => one.replace(/[\s,]/g, '').toLowerCase())
export function sameEvent(a: SearchResult, b: SearchResult, query: string): boolean {
  const asked = nameWords(query), unasked = (words: string[]): string[] => words.filter(word => !asked.some(one => alike(word, one)))
  const mine = unasked(nameWords(a.title)), theirs = unasked(nameWords(b.title))
  const shared = mine.filter(word => theirs.some(one => alike(word, one)))
  if (!shared.length) return false
  const held = (words: string[], other: SearchResult): number => { const hay = nameWords(`${other.title} ${other.snippet}`); return words.filter(word => hay.some(one => alike(word, one))).length }
  const receivers = (row: SearchResult): string[] => unasked(row.title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3 && /(에|에게)$/.test(word)).flatMap(nameWords))
  const to = receivers(a), from = receivers(b)
  if (to.length && from.length && !held(to, b) && !held(from, a)) return false
  if (a.date && a.date === b.date && amounts(a.title).some(one => amounts(b.title).includes(one))) return true
  if (mine.length > 1 && theirs.length > 1 && alike(mine[0]!, theirs[0]!) && !alike(mine[1]!, theirs[1]!) && !held([mine[1]!], b) && !held([theirs[1]!], a)) return false
  return held(mine, b) >= 2 || held(theirs, a) >= 2 || shared.some(word => word.length >= 3) && !!a.date && a.date === b.date && (held(mine, b) === mine.length || held(theirs, a) === theirs.length)
}
export const withoutRepeats = (rows: SearchResult[], query: string): SearchResult[] => rows.filter((row, i) => !rows.slice(0, i).some(earlier => sameEvent(earlier, row, query)))
const KO_COUNT = ['한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'], EN_COUNT = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
export function askedCount(ask: string): number | undefined {
  const said = /(\d{1,2}|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(?:개|건|가지|꼭지)|\btop (\d{1,2})\b|\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten) (?:\w+ ){0,2}(?:news|articles?|stories|items|headlines)\b/i.exec(ask)
  const word = (said?.[1] ?? said?.[2] ?? said?.[3])?.toLowerCase()
  if (!word) return undefined
  return /^\d/.test(word) ? Number(word) : KO_COUNT.indexOf(word) + 1 || EN_COUNT.indexOf(word) + 1
}

export function rankLinks(
  links: { text: string; url: string }[],
  query: string,
  cap = 5,
  from?: string,
): { text: string; url: string }[] {
  const words = query
    .toLowerCase()
    .split(/[\s,./?!]+/)
    .filter((word) => word.length > 1)
  const scored = resultLinks(links, from).map((link, order) => {
    const hay = `${link.text} ${link.url}`.toLowerCase()
    const hits = words.filter((word) => (isLatin(word) ? hay.includes(word) : gluedWord(word, hay))).length
    return { link, score: hits * 100 + Math.min(link.text.length, 60) - order / 100 }
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((one) => one.link)
}

function isLatin(word: string): boolean {
  return /^[\p{Script=Latin}\p{Nd}\p{P}]+$/u.test(word)
}

const STEM_MIN = 4

function gluedWord(word: string, hay: string): boolean {
  if (hay.includes(word)) return true
  if (word.length >= 3 && hay.includes(word.slice(0, -1))) return true
  return word.length >= 4 && hay.includes(word.slice(0, -2))
}

function sameWord(word: string, tokens: Set<string>): boolean {
  if (tokens.has(word)) return true
  if (word.length < STEM_MIN) return false
  for (const token of tokens) {
    if (token.length < STEM_MIN) continue
    if (token.startsWith(word) || word.startsWith(token)) return true
  }
  return false
}

export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,./?!"'()[\]{}<>:;]+/)
    .filter((word) => word.length > 1)
}

const POINTERS = new Set([
  '그거', '그것', '저거', '저것', '이거', '이것', '이걸', '그걸', '저걸', '그건', '이건', '저건',
  'that', 'this', 'those', 'these', 'them', 'one', 'thing', 'stuff', 'same',
])
const ASKING = new Set([
  '처리', '해결', '정리', '확인', '진행', '부탁', '해줘', '해주세요', '해봐', '해줄래', '하기', '하자', '해요', '해라', '해',
  '다시', '빨리', '지금', '얼른', '한번', '제발', '그냥', '바로', '먼저', '아까', '방금',
  'please', 'handle', 'do', 'deal', 'fix', 'check', 'take', 'care', 'of', 'go', 'ahead', 'run', 'make', 'get', 'sort',
  'out', 'with', 'just', 'now', 'again', 'it', 'the', 'a', 'an', 'on', 'for', 'to', 'can', 'you', 'and', 'then',
])
export function namesSubject(text: string): boolean {
  return contentWords(text).some((word) => {
    if (POINTERS.has(word) || ASKING.has(word)) return false
    const stem = word.replace(/(해주세요|해줄래|해줘|해봐|해라|하자|해요|해|좀|요)$/u, '')
    return stem.length > 1 && !POINTERS.has(stem) && !ASKING.has(stem)
  })
}

const WRITE_WORDS = /노트로|노트에|메모로|메모해|적어|저장해|기록해|남겨|write (it |this |that )?down|save (it|this|that)|jot|make a note|as a note/i
export function asksForNote(text: string): boolean {
  return WRITE_WORDS.test(text)
}

const ASK_TAIL = /s*(노트로|노트에|메모로|메모해|적어|저장해|기록해|남겨)[^s]*s*(만들어s*줘|만들어s*주세요|줘|주세요|둬|두세요)?s*[.!]*$|^s*(pleases+)?(write (it |this |that )?down|make a note of|save|jot down)s*|s*(as a note|,? ?please)s*[.!]*$/giu
export function noteTitleFor(task: string): string {
  const title = task.replace(ASK_TAIL, ' ').replace(/\s+/g, ' ').trim().replace(/[을를]$/u, '')
  return (title || task).slice(0, 60)
}

export function answersTheQuestion(found: string, query: string): boolean {
  const hay = found.toLowerCase()
  const tokens = new Set(contentWords(found))
  const words = contentWords(query)
  if (words.length === 0) return false
  return words.some((word) => (isLatin(word) ? sameWord(word, tokens) : gluedWord(word, hay)))
}

export const SEMANTIC_NOISE = 0.35

export const SEMANTIC_SURE = 0.65
