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
const SHOWN_DATE = /\d+\s*(?:분|시간|일|주|개월|달|년)\s*전|어제|그저께|\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\.?|\d+\s*(?:minutes?|mins?|hours?|days?|weeks?|months?|years?)\s+ago|\byesterday\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4}/gi
const RESULT_SNIPPET = 160
// grokbar c4 R3/H6: a news table's date column read "1주 전 / 1주 전 / 11시간 전": the results page's own age was passed through as written.
// An age is turned into the calendar date it means, from the time the page was fetched, before the model sees it; a written date is left alone.
// words: also "어제" / "yesterday" (a result's date label); in running page text those are left, where "어제보다 2° 높아요" is not a date.
const AGO = /(\d+)\s*(분|시간|일|주|개월|달|년)\s*전|(\d+)\s*(minute|min|hour|day|week|month|year)s?\s+ago|(그저께|어제|\byesterday\b)/gi
const AGO_MINUTES: Record<string, number> = { 분: 1, minute: 1, min: 1, 시간: 60, hour: 60, 일: 1440, day: 1440, 주: 10080, week: 10080 }
export function calendarDates(text: string, now = new Date(), words = true): string {
  return text.replace(AGO, (whole: string, n?: string, unit?: string, n2?: string, unit2?: string, word?: string) => {
    if (word && !words) return whole
    const at = new Date(now), count = Number(n ?? n2 ?? (word === '그저께' ? 2 : 1)), per = (unit ?? unit2 ?? '일').toLowerCase()
    // c4 r3: March 31 less a month overflowed to March 3; a day the earlier month does not have is that month's last day.
    if (/개월|달|month/.test(per)) { at.setMonth(at.getMonth() - count); if (at.getDate() !== now.getDate()) at.setDate(0) }
    else if (/년|year/.test(per)) { at.setFullYear(at.getFullYear() - count); if (at.getDate() !== now.getDate()) at.setDate(0) }
    else at.setTime(at.getTime() - count * AGO_MINUTES[per]! * 60_000)
    const sameYear = at.getFullYear() === now.getFullYear()
    return /[가-힣]/.test(whole) ? `${sameYear ? '' : `${at.getFullYear()}년 `}${at.getMonth() + 1}월 ${at.getDate()}일` : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
  })
}
export function searchResults(links: { text: string; url: string }[], text: string, query: string, from?: string, cap = 8, now = new Date()): SearchResult[] {
  let page: URL | null = null
  try { page = from ? new URL(from) : null } catch { page = null }
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
    return [{ result: { title: title.slice(0, 120), url, snippet: calendarDates(snippet, now, false), date: calendarDates(date, now) }, hits, score: hits * 100 + Math.min(title.length, 60) - order / 100 }]
  })
  // When the page has results that echo the question, what echoes none of it is furniture that got through (an outlet's home, a promo).
  const echoing = scored.filter(one => one.hits > 0)
  return (echoing.length >= 3 ? echoing : scored).sort((a, b) => b.score - a.score).slice(0, cap).map(one => one.result)
}

// A news ask is searched where news is listed: each entry an article with its outlet and date, not a blog round-up
// (grokbar c3 R3/H6: the web tab gave two weekly round-up posts for "AI 스타트업 투자 뉴스").
export const NEWS_ASK = /뉴스|기사|속보|보도\s?자료|헤드라인|\b(news|headlines?)\b/i
// shortcut: only Naver's news tab is known; another engine's template is searched as it is, add its news address here when one is used.
export function newsTemplate(template: string): string {
  try {
    const url = new URL(template.replace('{q}', 'QQ'))
    if (url.host !== 'search.naver.com') return template
    url.searchParams.set('where', 'news')
    return url.toString().replace('QQ', '{q}')
  } catch { return template }
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
