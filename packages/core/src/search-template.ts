import { siteOf } from './search-links.js'
// Where to search is the person's choice, not this codebase's. Rather than
// naming engines in code — which fixes the answer for everyone and cannot
// learn a company's own search — the app learns the shape once: the person
// pastes a result address from whatever they already use, and the query in it
// becomes a blank to fill next time.

// The address with the search terms swapped for {q}, or null if that address
// carries no terms at all.
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
  // The parameter holding the words: the one that matches what was searched
  // for, or failing that the longest — which is what a query looks like
  // beside tracking ids and locale codes.
  const named = wanted ? params.find(([, value]) => value.trim().toLowerCase() === wanted) : undefined
  const longest = params.reduce((best, one) => (one[1].length > best[1].length ? one : best), params[0]!)
  const chosen = named ?? longest
  if (chosen[1].trim().length < 2) return null
  url.searchParams.set(chosen[0], '{q}')
  // searchParams escapes the braces; the template must keep them readable.
  return url.toString().replace('%7Bq%7D', '{q}')
}

// Fill the blank. Returns null when the template lost its placeholder, so a
// caller never silently searches for nothing.
// The search used until the person's own is learned: a public results page that answers plain questions (weather, a price, a rate) on the page itself.
// grokbar: with no address known, search_web answered "open a results page yourself" in 1 ms and the page the model then guessed met a robot check:
// two model rounds (~10 s) per lookup before anything was read.
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

// A results page is mostly furniture: menus, promos, the site's own apps.
// Ordering the links by how much of the question they echo picks the result
// and leaves the furniture — without knowing whose page it is.
// A results page links to itself as much as to the world: the image and
// news tabs, the next page, the same words in another language. Those are
// the search again, not a result, and a comet that opened one read its own
// query back. Where the page hands out redirect links, the address behind
// them is the one shown, so the list reads as the sites it actually is.
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

// What a results page lists, one entry per address: its title, the words under it and the date beside it.
// grokbar c3 R2/R3: the first anchors of a Naver or Bing results page are tabs, filters and ads (measured on saved pages: the first
// article is anchor 60 of 344), and one result is several anchors (outlet, date, title, snippet). So the page's anchors are grouped by
// where they lead, the furniture is dropped, and the rest is ordered by how much of the question each echoes.
export interface SearchResult { title: string; url: string; snippet: string; date: string }
const NEW_WINDOW = /\s*(새\s?창\s?열림|opens? in (a )?new (window|tab))\s*/gi
const AD_HOST = /(^|\.)(ad|ads|ader|adcr|adclick|saedu|doubleclick|googleadservices|googlesyndication)\./i
const SHOWN_DATE = /\d+\s*(?:분|시간|일|주|개월|달|년)\s*전|어제|그저께|\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\.?|\d{4}년\s*\d{1,2}월\s*\d{1,2}일|\d{4}-\d{2}-\d{2}|\d+\s*(?:minutes?|mins?|hours?|days?|weeks?|months?|years?)\s+ago|\byesterday\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4}/gi
// c5a r2: "2024년 4월 16일" and "2024-04-16" were not read as a date, so an old article had none and passed the recent-news filter as undated.
const RESULT_SNIPPET = 160
// grokbar c4 R3/H6: a news table's date column read "1주 전 / 1주 전 / 11시간 전": the results page's own age was passed through as written.
// An age is turned into the calendar date it means, from the time the page was fetched, before the model sees it; a written date is left alone.
// words: also "어제" / "yesterday" (a result's date label); in running page text those are left, where "어제보다 2° 높아요" is not a date.
const AGO = /(\d+)\s*(분|시간|일|주|개월|달|년)\s*전|(\d+)\s*(minute|min|hour|day|week|month|year)s?\s+ago|(그저께|어제|\byesterday\b)/gi
const AGO_MINUTES: Record<string, number> = { 분: 1, minute: 1, min: 1, 시간: 60, hour: 60, 일: 1440, day: 1440, 주: 10080, week: 10080 }
// korean: the language of the ask. A Korean ask reads an English age ("2 days ago" on an English results page) as a Korean date too
// (c4a review r3: "Nov 15" reached a Korean thread); without it the date follows the label's own language.
export function calendarDates(text: string, now = new Date(), words = true, korean?: boolean): string {
  return text.replace(AGO, (whole: string, n?: string, unit?: string, n2?: string, unit2?: string, word?: string) => {
    if (word && !words) return whole
    const at = new Date(now), count = Number(n ?? n2 ?? (word === '그저께' ? 2 : 1)), per = (unit ?? unit2 ?? '일').toLowerCase()
    // c4 r3: March 31 less a month overflowed to March 3; a day the earlier month does not have is that month's last day.
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
  // A Korean query's dates are Korean whatever the page's language; any other query keeps the label's own.
  const korean = /[가-힣]/.test(query) || undefined
  const groups = new Map<string, string[]>()
  for (const link of resultLinks(links, from)) {
    let url: URL
    try { url = new URL(link.url) } catch { continue }
    if (!/^https?:$/.test(url.protocol) || AD_HOST.test(url.host)) continue
    // The engine's own front doors (its home, its help, its sign-in) are not results; a page deeper in one of its sites (a blog post, an article) is.
    if (page && siteOf(url.host) === siteOf(page.host) && url.pathname.length <= 1) continue
    // Bing's redirector, where it leads back into Bing (its tabs, its terms): resultLinks unwrapped the ones that lead out.
    if (page && url.host === page.host && url.pathname === '/ck/a') continue
    const label = link.text.replace(NEW_WINDOW, ' ').replace(/\s+/g, ' ').trim()
    url.hash = ''
    if (label) groups.set(url.href, [...(groups.get(url.href) ?? []), label])
  }
  const words = query.toLowerCase().split(/[\s,./?!]+/).filter(word => word.length > 1)
  const dateOf = (value: string): string => value.match(SHOWN_DATE)?.at(-1) ?? ''
  const scored = [...groups].flatMap(([url, labels], order) => {
    const isDate = (label: string): boolean => label.length <= 24 && !!dateOf(label)
    // The line that shows the address ("apple.com https://www.apple.com › iphone") is not the title.
    const titles = labels.filter(label => !isDate(label) && !/https?:\/\/|›/.test(label) && label.length >= 4)
    const title = titles[0]
    if (!title) return []
    const at = text.indexOf(title.slice(0, 60))
    const own = titles.find(label => label !== title && label.length > 40)
    // Without words of its own under the title, the two lines after it are the result's (a related article: its outlet, its date).
    const after = at < 0 ? '' : text.slice(at + title.length, at + title.length + RESULT_SNIPPET).replace(NEW_WINDOW, ' ').trim().split('\n').slice(0, 2).join(' ')
    const snippet = (own ?? after).replace(/\s+/g, ' ').trim().slice(0, RESULT_SNIPPET)
    // The date sits beside the title: one of the result's own anchors, or the line above it (outlet, "9시간 전") when its words follow, or right after it.
    const date = dateOf(labels.find(isDate) ?? '') || (own ? '' : after.match(SHOWN_DATE)?.[0] ?? '') || (at < 0 ? '' : dateOf(text.slice(Math.max(0, at - 120), at)))
    // Counted on the result's own words: the page text after a menu link is the next result's.
    const hay = `${title} ${own ?? ''} ${url}`.toLowerCase()
    const hits = words.filter(word => (isLatin(word) ? hay.includes(word) : gluedWord(word, hay))).length
    return [{ result: { title: title.slice(0, 120), url, snippet: calendarDates(snippet, now, false, korean), date: calendarDates(date, now, true, korean) }, hits, score: hits * 100 + Math.min(title.length, 60) - order / 100 }]
  })
  // When the page has results that echo the question, what echoes none of it is furniture that got through (an outlet's home, a promo).
  const echoing = scored.filter(one => one.hits > 0)
  // grokbar c5 R2: three lookups each got a page of blog posts and all three rows were cited to "네이버 블로그". The best row of each site
  // is the only one kept (c5a r2: a site's further rows used to fill the cap, so a page of blogs was three rows of one source), a maker's
  // or an outlet's page before a blog, café or forum post. A blog is never dropped for being one: when only blogs exist, the best is returned.
  // c5a r3: no exception for a site's own search either; one row per site is the rule everywhere.
  const seen = new Set<string>(), lead: typeof scored = []
  for (const one of (echoing.length >= 3 ? echoing : scored).sort((a, b) => b.score - a.score)) { const site = siteKey(one.result.url); if (!seen.has(site)) lead.push(one); seen.add(site) }
  // c7 R2: a video post sinks with them: all three rows of a product comparison were cited to blog posts and a video.
  const sinks = (one: typeof scored[number]): number => Number(communityPost(one.result.url) || VIDEO_POST.test(one.result.url))
  return lead.sort((a, b) => sinks(a) - sinks(b)).slice(0, cap).map(one => one.result)
}
const siteKey = (url: string): string => new URL(url).hostname.replace(/^(www|m)\./, '')
// shortcut: a closed list of places where anyone posts; another one is ranked as a site of its own until it is added here.
const COMMUNITY = /(^|\.)(blog\.naver\.com|cafe\.naver\.com|post\.naver\.com|tistory\.com|brunch\.co\.kr|dcinside\.com|clien\.net|fmkorea\.com|ppomppu\.co\.kr|velog\.io|medium\.com)$/
const VIDEO_POST = /^https?:\/\/(?:[\w-]+\.)*(?:youtube\.com|youtu\.be|tv\.naver\.com|tiktok\.com)\//i
// Whether an address is a post on one of them (team-hire-tools names such a source by its title, never by the place).
export const communityPost = (url: string): boolean => { try { return COMMUNITY.test(siteKey(url)) } catch { return false } }

// A news ask is searched where news is listed: each entry an article with its outlet and date, not a blog round-up
// (grokbar c3 R3/H6: the web tab gave two weekly round-up posts for "AI 스타트업 투자 뉴스").
export const NEWS_ASK = /뉴스|기사|속보|보도\s?자료|헤드라인|\b(news|headlines?)\b/i
// shortcut: only Naver's news tab is known; another engine's template is searched as it is, add its news address here when one is used.
// period: Naver's own period buttons build nso=…p:1d / p:1w / p:1m (read on saved results pages, tmp/grokbar/b1-probe; its news tab
// writes nso=so:r,p:all,a:all), so a recent-news ask is searched with that. The host filters by date as well, whatever the page does.
export function newsTemplate(template: string, period?: NewsPeriod): string {
  try {
    const url = new URL(template.replace('{q}', 'QQ'))
    if (url.host !== 'search.naver.com') return template
    url.searchParams.set('where', 'news')
    if (period) url.searchParams.set('nso', `so:r,p:${{ day: '1d', week: '1w', month: '1m', year: '1y' }[period]},a:all`)
    return url.toString().replace('QQ', '{q}')
  } catch { return template }
}
// grokbar c5 R3/H6: "요즘 … 투자 뉴스" was searched by relevance over all time and came back as three 2024 rounds, a plan and a visit.
// A news ask that says when is searched for that period: a day for 오늘, a week for 이번 주, a month for 요즘 / 최근 / 이번 달.
// year: never asked for by a word; it bounds the wider page that fills a counted list (c6 R3), so a 2024 article is not "요즘" news.
export type NewsPeriod = 'day' | 'week' | 'month' | 'year'
const PERIODS: [RegExp, NewsPeriod][] = [[/오늘|\btoday\b/i, 'day'], [/이번\s?주|금주|\bthis week\b/i, 'week'], [/요즘|요새|최근|이번\s?달|\b(recent|recently|lately|these days|this month)\b/i, 'month']]
const PERIOD_DAYS: Record<NewsPeriod, number> = { day: 1, week: 7, month: 31, year: 366 }
export const newsPeriod = (ask: string): NewsPeriod | undefined => PERIODS.find(([words]) => words.test(ask))?.[1]
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// The day a result's date names, as searchResults writes it ("11월 13일", "2024년 4월 16일", "2024.04.16.", "2024-04-16", "Nov 15", "Apr 16, 2024"); null when it names none.
export function resultDay(date: string, now = new Date()): Date | null {
  const dot = /(\d{4})(?:\.\s?|-)(\d{1,2})(?:\.\s?|-)(\d{1,2})/.exec(date), ko = /(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/.exec(date), en = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:,? (\d{4}))?/i.exec(date)
  const [year, month, day] = dot ? [dot[1], Number(dot[2]), dot[3]] : ko ? [ko[1], Number(ko[2]), ko[3]] : en ? [en[3], MONTHS.indexOf(en[1]!.toLowerCase()) + 1, en[2]] : []
  if (!month || !day) return null
  const at = new Date(Number(year ?? now.getFullYear()), month - 1, Number(day))
  // Written with no year, a day that has not come yet is last year's.
  if (!year && at.getTime() > now.getTime() + 86_400_000) at.setFullYear(at.getFullYear() - 1)
  return at
}
// A row with no date is kept: nothing says it is old.
export function inPeriod(date: string, period: NewsPeriod, now = new Date()): boolean {
  const at = resultDay(date, now)
  return !at || at.getTime() >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - PERIOD_DAYS[period]).getTime()
}
// An older row says its year, so "9월 3일" is never read as this month's news.
export function datedWithYear(date: string, now = new Date()): string {
  const at = /\d{4}/.test(date) ? null : resultDay(date, now)
  return !at ? date : /월/.test(date) ? `${at.getFullYear()}년 ${date}` : `${date}, ${at.getFullYear()}`
}
// c6 R3/H6: one announcement reported by two outlets filled two of five places ("엔비디아 … 포인트투테크놀로지 … 투자" twice), and the
// refill never ran because the rows were there. A news row that names the same parties as an earlier one is the same event and is dropped.
// Measured on the saved news page for this ask (test fixture naver-news): 7 of its 12 rows are that one announcement.
// shortcut: no name recognition. A party is a title word that is not the query's, not a number and not a common news word; two rows are one
// event when their titles share one and either one row's title has two that the other's title or words under it also hold, or the two
// carry the same date and one of them names nobody the other does not (a shorter headline of the same thing). c6a r2: the date and one
// shared name alone made "카카오벤처스 뤼튼에 100억 투자" and "카카오벤처스 업스테이지에 200억 투자" one event; each names a party the other lacks.
// A word left over that is no name ("확정") makes two reports of one thing on one day two rows; use a tagger if that shows.
const PARTICLE = /(한다|했다|된다|됐다|으로|에서|에도|에게|까지|부터|이|가|은|는|을|를|의|에|와|과|도|로)$/
const NEWS_WORD = /^(투자|유치|발표|공개|계획|추가|규모|시리즈\w*|라운드|단독|종합|속보|국내|한국|해외|글로벌|스타트업|기업|업체|회사|올해|내년|최대|신규|완료|성공|확대|진출|체결|내역|펀드|시드|프리\w*|브릿지|엔젤|후속|전략적?|주도|참여|단행|마무리|자금|조달|뉴스|기사|관련|기술|협력|강화|추진|한다|논란|기반|사업|서비스|개발|지원|시장|산업|플랫폼|솔루션|인공지능|ai|news|startups?|funding|raises?|invest\w*|series|round|seed|pre|bridge|angel|follow|million|billion|korean?)$/i
const nameWords = (text: string): string[] => [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).map(word => word.length >= 3 ? word.replace(PARTICLE, '') : word).filter(word => word.length >= 2 && !/^\d/.test(word) && !NEWS_WORD.test(word)))]
// An ending the particle list missed still matches by its start ("포인트투테크놀로지" in "포인트투테크놀로지스"), from three characters.
const alike = (a: string, b: string): boolean => a === b || Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))
export function sameEvent(a: SearchResult, b: SearchResult, query: string): boolean {
  const asked = nameWords(query), unasked = (words: string[]): string[] => words.filter(word => !asked.some(one => alike(word, one)))
  const mine = unasked(nameWords(a.title)), theirs = unasked(nameWords(b.title))
  const shared = mine.filter(word => theirs.some(one => alike(word, one)))
  if (!shared.length) return false
  const held = (words: string[], other: SearchResult): number => { const hay = nameWords(`${other.title} ${other.snippet}`); return words.filter(word => hay.some(one => alike(word, one))).length }
  // c6a r3: "카카오벤처스 뤼튼에 시드 투자" and "카카오벤처스 업스테이지에 시드 투자" shared two words, the investor and a funding word no list held.
  // Who the money went to ("뤼튼에") settles it before any count: each row says one and the other row never mentions it, so they are two events.
  // shortcut: only the 에 / 에게 ending marks who received; a headline without it ("뤼튼 시드 투자") is told apart by the word list alone.
  const receivers = (row: SearchResult): string[] => unasked(row.title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3 && /(에|에게)$/.test(word)).flatMap(nameWords))
  const to = receivers(a), from = receivers(b)
  if (to.length && from.length && !held(to, b) && !held(from, a)) return false
  // c7 (c6a review r3 #1): "카카오벤처스 뤼튼 깜짝 투자" and "카카오벤처스 업스테이지 깜짝 투자" were one event: the investor and "깜짝" made two
  // shared words. Two rows are one event only when the company that was funded matches: when both titles open on the same name (the
  // investor) and the name after it differs, each unknown to the other row, they are two rounds.
  // shortcut: by position only (investor first, the funded company next); a headline in another order is told apart by the rules below.
  if (mine.length > 1 && theirs.length > 1 && alike(mine[0]!, theirs[0]!) && !alike(mine[1]!, theirs[1]!) && !held([mine[1]!], b) && !held([theirs[1]!], a)) return false
  return held(mine, b) >= 2 || held(theirs, a) >= 2 || shared.some(word => word.length >= 3) && !!a.date && a.date === b.date && (held(mine, b) === mine.length || held(theirs, a) === theirs.length)
}
export const withoutRepeats = (rows: SearchResult[], query: string): SearchResult[] => rows.filter((row, i) => !rows.slice(0, i).some(earlier => sameEvent(earlier, row, query)))
// c7 R3: five were asked for, the results held three funding rounds, and the list was filled with an acquisition mention and a row that
// named no company. For a counted news ask the host orders the rows by their titles: 2 when the title names the event asked for beside
// somebody (for an investment ask: a company with 유치 / 투자받 / 시리즈 A-C / an amount in 억 원), 0 when it only mentions it (a forum,
// a visit, a portfolio, a plan to raise, an acquisition), 1 otherwise or when the ask is of a kind not listed here.
// shortcut: one kind of event (investment), by title words and no name recognition; add a row here for another kind of counted news.
const EVENTS: [ask: RegExp, names: RegExp, mentions: RegExp][] = [
  [/투자|펀딩|\b(?:funding|invest\w*|raises?)\b/i, /유치|투자\s?받|시리즈\s?[A-C]|\d[\d,.]*\s*(?:억|조)\s*원?|\bseries [a-c]\b|\braises? \$/i, /포럼|방문|포트폴리오|간담회|설명회|엑스포|박람회|협약|\bMOU\b|인수|데모데이|모집|지원\s?사업|추진|검토|나선다|목표|언급|사례/i],
]
// c7a r2: "국내 AI 스타트업 미국 투자 유치" ranked first: "미국" was counted as the company funded. A country, a region or a word for who or
// how much is nobody's name.
// shortcut: a closed word list, no name recognition; a describing word it lacks still passes as a name. Use a tagger if that shows.
const NO_NAME = /^(미국|중국|일본|유럽|영국|독일|프랑스|인도|동남아|중동|아시아|북미|남미|싱가포르|베트남|대만|홍콩|실리콘밸리|서울|부산|경기|판교|지역|지방|정부|벤처|벤처투자자?|투자자|투자사|벤처캐피탈|vc|대규모|대형|역대급|역대|사상|최대|최고|최초|초대형|초기|누적|총|약|무려|단숨에|연쇄|추가|후속|신규|잇단|잇따라|연이어|연달아|줄줄이|속속|본격|활발|급증|증가|감소|열풍|훈풍|한파|러시|봇물|행진|전망|분석|현황|동향|상반기|하반기|분기|이번|지난|최근|us|usa|china|japan|europe|asia|global|investors?|venture|capital)$/i
// c7a r3: "국내 AI 스타트업 연쇄 투자 유치" and "… 사상 최대 투자 유치" ranked first: any word the lists lacked was the company. A word is the
// funded company only where the headline marks it as one: a comma or a middle dot after it ("뤼튼, …"), or the round right after it
// ("리벨리온 620억 원", "아크 시리즈 B", "Wrtn raises"). The lists above only take words away from those.
// shortcut: by headline form, no name recognition. A company named with neither mark ("업스테이지 투자 유치 성공") is rank 1: listed, behind
// the marked ones; a describing word right before an amount ("역대급 300억") still passes. Use a tagger if either shows.
const NAMED_BY = /^\s?[,·]|^\s*(?:\d[\d,.]*\s*(?:억|조)|시리즈|(?:raises?|secures?|closes?)\b)/i
export function eventRank(row: SearchResult, ask: string): 0 | 1 | 2 {
  const kind = EVENTS.find(([words]) => words.test(ask))
  if (!kind) return 1
  if (kind[2].test(row.title)) return 0
  if (!kind[1].test(row.title)) return 1
  const asked = nameWords(ask)
  const named = [...row.title.matchAll(/[\p{L}\p{N}]+/gu)].some(word => NAMED_BY.test(row.title.slice(word.index + word[0].length))
    && nameWords(word[0]).some(name => !NO_NAME.test(name.replace(/(에서|서)$/, '')) && !asked.some(one => alike(name, one))))
  return named ? 2 : 1
}
// How many the person asked for ("3개만", "다섯 건", "top 5", "three articles"), when they said.
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
    // The same reading as everywhere else: a word counts when the page says
    // it, ending or no ending. Counting whole words only put a page whose
    // title happened to share one generic word above the one that held the
    // answer (measured).
    const hits = words.filter((word) => (isLatin(word) ? hay.includes(word) : gluedWord(word, hay))).length
    // A headline is longer than a menu item; among equals, prefer the one
    // that reads like a sentence, then the page's own order.
    return { link, score: hits * 100 + Math.min(link.text.length, 60) - order / 100 }
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((one) => one.link)
}

// Written with spaces between the words, or with the endings glued on?
function isLatin(word: string): boolean {
  return /^[\p{Script=Latin}\p{Nd}\p{P}]+$/u.test(word)
}

// A language that writes its words apart is matched word for word - a
// substring hit finds "me" inside "deployment" and calls an unrelated page an
// answer. Endings still have to give, though: "deploys" and "deploy" are the
// same question, so a shared start is enough once the word is long enough to
// mean something on its own.
const STEM_MIN = 4

// Where the endings are glued on, the word the person typed and the word on
// the page differ only at the tail: inflected forms can share a subject and
// not a single token. Dropping a syllable or two off the end is enough to see
// it, and short words are left alone so the match stays a match.
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

// The words a question is actually about — what is left once the tokens too
// short to anchor anything are dropped.
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,./?!"'()[\]{}<>:;]+/)
    .filter((word) => word.length > 1)
}

// Does the request name anything to work on? "Handle that" names nothing:
// every word in it points or asks, and a lookup for it lands on whatever is
// nearest. Pointers, the bare verbs of asking and the adverbs of urgency are
// listed; anything left is a subject.
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

// Did the person ask for something written down? A request that says so and
// ends in prose is unfinished, however good the prose - measured: two notes
// merged beautifully into an answer, and no note.
const WRITE_WORDS = /노트로|노트에|메모로|메모해|적어|저장해|기록해|남겨|write (it |this |that )?down|save (it|this|that)|jot|make a note|as a note/i
export function asksForNote(text: string): boolean {
  return WRITE_WORDS.test(text)
}

// The title such a note gets when the loop writes it down itself: the request
// with the asking taken off - "make a note of X" becomes "X".
const ASK_TAIL = /s*(노트로|노트에|메모로|메모해|적어|저장해|기록해|남겨)[^s]*s*(만들어s*줘|만들어s*주세요|줘|주세요|둬|두세요)?s*[.!]*$|^s*(pleases+)?(write (it |this |that )?down|make a note of|save|jot down)s*|s*(as a note|,? ?please)s*[.!]*$/giu
export function noteTitleFor(task: string): string {
  const title = task.replace(ASK_TAIL, ' ').replace(/\s+/g, ' ').trim().replace(/[을를]$/u, '')
  return (title || task).slice(0, 60)
}

// Did what came back have anything to do with what was asked? A question that
// names nothing — "handle that" with no "that" in sight — searches perfectly
// well and lands on a page about something else entirely, and the only honest
// next move is to ask rather than to write up whatever turned up.
export function answersTheQuestion(found: string, query: string): boolean {
  const hay = found.toLowerCase()
  const tokens = new Set(contentWords(found))
  const words = contentWords(query)
  if (words.length === 0) return false
  return words.some((word) => (isLatin(word) ? sameWord(word, tokens) : gluedWord(word, hay)))
}

// The embedder answers every question with its nearest few notes, so being
// returned says nothing at all. Below this the neighbour is noise rather than
// a neighbour - it is the same floor the vault's own hybrid search uses, and
// the only thing a similarity score can honestly be asked to decide.
export const SEMANTIC_NOISE = 0.35

// And where it stops being a guess. Above this the embedder is saying "same
// subject, other words"; below it the notes are neighbours worth showing and
// no more, which is when the page is worth a look as well.
export const SEMANTIC_SURE = 0.65
