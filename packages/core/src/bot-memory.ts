import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { withoutReplies } from './agent-history.js'
import { namesSubject } from './search-template.js'
import { secretsIn } from './secrets.js'
import type { VaultPaths } from './vault.js'

// What a comet remembers about the person across every conversation: short
// facts, each with the day it was first written and the day it was last said
// again. The vault is the person's memory; this is the comet's reading of the
// person, kept apart from it, small, and theirs to delete line by line.

export interface BotFact {
  id: string
  text: string
  // First written - the order facts are rendered in, so the prompt head only
  // ever grows at the end and the model's prefix cache keeps working.
  at: string
  // Last said again - the clock the fact fades by.
  touchedAt: string
}

export interface BotMemoryFile {
  facts: BotFact[]
  turns: number
  // Leading facts that came from the shared layer; set only by mergeMemory.
  shared?: number
}

const MEMORY_DIR = 'bot-memory'
// A fact said a month ago weighs half of one said today; one never said
// again fades out of the prompt in a few months and stays on disk.
const HALF_LIFE_DAYS = 30
const FACT_CHARS = 160
// Each layer is capped by rendered characters and lines, the shared one first so the prompt head stays cache-stable.
export const MEMORY_BUDGET = { shared: { chars: 1200, lines: 14 }, own: { chars: 600, lines: 8 } } as const
export const DISK_CAP = 200
const DAY_MS = 86_400_000

function memoryPath(paths: VaultPaths, botId: string): string {
  return join(paths.cache, MEMORY_DIR, `${botId}.json`)
}

const queues = new Map<string, Promise<unknown>>()
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work)
  queues.set(key, next.catch(() => undefined))
  return next
}

export async function loadBotMemory(paths: VaultPaths, botId: string): Promise<BotMemoryFile> {
  try {
    const raw = JSON.parse(await readFile(memoryPath(paths, botId), 'utf8')) as Partial<BotMemoryFile>
    const facts = Array.isArray(raw.facts)
      ? raw.facts.filter(
          (f): f is BotFact =>
            typeof f?.id === 'string' && typeof f?.text === 'string' && typeof f?.at === 'string' && typeof f?.touchedAt === 'string' && !notAFact(f.text),
        )
      : []
    return { facts: settleFacts(facts), turns: typeof raw.turns === 'number' ? raw.turns : 0 }
  } catch {
    return { facts: [], turns: 0 }
  }
}

async function saveBotMemory(paths: VaultPaths, botId: string, file: BotMemoryFile): Promise<void> {
  await mkdir(join(paths.cache, MEMORY_DIR), { recursive: true })
  await writeFile(memoryPath(paths, botId), JSON.stringify(file, null, 2))
}

// Greetings, acknowledgements and requests that name nothing carry nothing
// worth keeping; neither does a turn the comet could not answer.
const TRIVIAL = /^(hi|hey|hello|thanks?|thank you|thx|ok|okay|k|cool|nice|great|yes|yep|no|nope|sure|bye|고마워요?|감사합니다|ㅇㅋ|오케이|응|네|넵|아니요?|알겠어요?|안녕하?세요?|잘가|수고해?요?)[\s!.~^ㅋㅎ]*$/i

// A value handed over only to be written back ("그대로 다시 적어 줘") is a
// probe of this one answer, not something the person told the comet to know.
const ECHO_PROBE = /다시\s*(적어|써|말해)|라고만\s*(적어|써|말해)|그대로\s*(적어|써|따라)|\b(repeat|echo) (it|this|that)\b|\b(write|say|type) (it|this|that) back\b/i
const ASKED_TO_KEEP = /기억|remember|keep in mind/i

export function memorableTurn(message: string, answer: string): boolean {
  const said = message.trim()
  if (said.length < 6 || !answer.trim()) return false
  if (TRIVIAL.test(said)) return false
  if (ECHO_PROBE.test(said) && !ASKED_TO_KEEP.test(said)) return false
  return namesSubject(said)
}

// Leftovers of an answer rather than a fact: headings, table rows, tool
// markup, the job's own name, a question, a label with nothing after it.
export function notAFact(text: string): boolean {
  const line = text.trim()
  return /^(#|\||<\/?[a-z]|```)|comet-remember|[?？:：](\*\*)?$/i.test(line) || eitherForm(PROMISE, line) || OWN_REPORT.test(line)
}

// The comet reporting what it just did ("…다른 것을 확인했어요") is about this one turn, not the person.
const OWN_REPORT = /(확인|저장|완료|수정|생성|작성)(했|하였)(어요|습니다)[\s.!]*$/

// Hangul endings are matched decomposed (ㄹ받침 is its own code point), whole words composed.
const eitherForm = (pattern: RegExp, line: string) => pattern.test(line) || pattern.test(line.normalize('NFD'))

// Someone speaking in the chat, not a note about the person: a promise or an
// offer ("알려줄게", "해 드릴게요", "I'll …") is a suggested reply or the comet's own voice.
const PROMISE = /\u11AF\s?\u1100\u1166(\u110B\u116D)?[\s.!~]*$|드리겠습니다[\s.!~]*$|^(i['’]ll|i will|i can|let me)\b/i

// An order ("…포함시킬 것", "…해 주세요") is a standing rule only when the person set that rule:
// the sentence of theirs that says "앞으로/always" must itself carry most of the rule's words.
// shortcut: words are compared by their first two Hangul letters (or whole, otherwise), no synonyms; a rule the person worded very differently is dropped.
const ORDER = /\u11AF\s?\u1100\u1165\u11BA[\s.!]*$|(하세요|주세요|하십시오|해\s?줘요?|지\s?마요?|지\s?마세요)[\s.!]*$|^(make sure|be sure|do not|don['’]t|please)\b/i
const STANDING = /앞으로|항상|매번|늘\s|언제나|다음부터|이제부터|지금부터|할 때마다|from now on|always|never|every time|whenever/i
const stems = (text: string) => (text.match(/[\p{L}\p{N}]{2,}/gu) ?? []).map((word) => (/[가-힣]/.test(word) ? word.slice(0, 2) : word.toLowerCase()))
function personSetRule(line: string, said: string): boolean {
  const rule = stems(line)
  return said.split(/[.!?。\n]+/).filter((sentence) => STANDING.test(sentence)).some((sentence) => {
    const theirs = new Set(stems(sentence))
    return rule.filter((stem) => theirs.has(stem)).length * 2 > rule.length
  })
}
const unaskedRule = (line: string, said: string) => eitherForm(ORDER, normalizeFact(line)) && !personSetRule(normalizeFact(line), said)

export function normalizeFact(text: string): string {
  return text
    // Only a list marker goes: a fact may begin with its own number ("11월 28일 출시").
    .replace(/^\s*(?:[-*•]\s*|\d+[.)]\s+)+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。!]+$/, '')
    .slice(0, FACT_CHARS)
}

// A correction replaces. A line may arrive carrying the value it replaces ("…(이전 11월 28일을 대체)",
// "…이고, 초안의 "TeStCode"는 오타입니다"): that part is cut, a line that is nothing else is dropped, and the
// value it names takes the older line about the same subject with it. Markers are kept narrow on purpose:
// a plain negation ("Slack은 쓰지 않는다") or "이전 직장" is an ordinary fact.
// shortcut: discarded values are read only when quoted, a date, or "X가 아니라"; subjects match by word stems, no synonyms.
// The subject of a line is its property ("킥오프 일정", "출시일"), not the project or team that owns it:
// two lines about one project are two subjects unless the property is the same.
const RESIDUE = /오타\s*(이|임|였|라|입니)|읽기\s*오류|(예전|이전|옛)\s*(\S+\s+)?(값|목표|마감|코드명|날짜|표기)|이전(에|\s*\S+에)\s*(쓰던|써\s?둔|적힌|적어\s?둔|사용하던)|더\s*이상\s*(쓰지|사용하지|유효하지)\s*않|[을를]\s*대체(함|됨|했\S*|합니다|한다)?$|\b(typo|misspell\w*|misread|(old|previous) value|no longer (used|valid|correct)|supersed\w+)\b/i
const NOT_BUT = /((?:\d+월\s*)?\S+)[이가]\s+아니라,?\s+/g
const STOP = new Set(['사용', '입니', '합니', '있습', '있어', '이다', '프로', 'the', 'is', 'are', 'of', 'to', 'in', 'on', 'for', 'and'])
const subject = (text: string) => new Set(stems(text.replace(/["“‘'][^"”’']*["”’']/g, ' ')).filter((stem) => !/^\d/.test(stem) && !STOP.has(stem)))
const unquoted = (text: string) => text.replace(/["“‘'][^"”’']*["”’']/g, ' ').trim()
// "은하호 프로젝트의 출시일은 …" -> owner ["은하호", "프로젝트의"], property ["출시일"]. A verb form ("진행하는 …") is not a topic.
function topicOf(text: string): { owner: string[]; property: string[]; rest: string; value: string } | null {
  const plain = unquoted(text)
  const topic = /^(.+?)(?<![하있없되\s])[은는]\s/.exec(plain)
  if (!topic?.[1]) return null
  const words = topic[1].trim().split(/\s+/)
  let cut = -1
  for (let i = 0; i < words.length - 1; i++) if (/(의|프로젝트|제품|팀)$/.test(words[i] ?? '')) cut = i
  return { owner: words.slice(0, cut + 1), property: words.slice(cut + 1), rest: plain.slice(plain.indexOf(words[cut + 1] ?? '')), value: plain.slice(topic[0].length).trim() }
}
const ownerWords = (owner: string[]) => owner.map((word) => word.replace(/의$/, '').replace(/^제품$/, '프로젝트')).filter((word) => !/^(출시|우리|저희|사용자)$/.test(word))
const ownerName = (owner: string[]) => ownerWords(owner).filter((word) => !/^(프로젝트|팀)$/.test(word)).join(' ')
function sameSubject(a: string, b: string): boolean {
  const [one, other] = [topicOf(a), topicOf(b)]
  if (one && other) {
    // Two named owners ("은하호 프로젝트", "별빛 프로젝트") are two subjects; an unnamed one ("프로젝트", "사용자의") matches any.
    const [mine, theirs] = [ownerName(one.owner), ownerName(other.owner)]
    if (mine && theirs && mine !== theirs) return false
    return one.property.join(' ') === other.property.join(' ') || stems(one.property.join(' ')).some((stem) => stems(other.property.join(' ')).includes(stem))
  }
  const theirs = subject(other?.rest ?? b)
  return [...subject(one?.rest ?? a)].some((stem) => theirs.has(stem))
}
// A newer line replaces an older one even when nothing says so in two cases. Anything else needs the value named
// ("replaces", "outdated:", a line carrying it).
// 1. Same owner and same property, another value: a property known to hold one value (코드명, 출시일 …), or any
//    "<owner>의 <property>는 <value>" line whose value is a bare value rather than a sentence of its own.
// 2. The same line with one word respelled ("지민호가" -> "민호가").
// shortcut: wording must match exactly apart from the value; a property that really holds several values ("민호의 취미는 …") keeps only the newest, and "행사 일정" without an owner, visits and the like are never merged.
const SINGLE_VALUED = /(코드명|출시일|마감일?|담당자?)$/
const bareValue = (value: string) => { const words = value.split(/\s+/); return words.length <= 4 && !words.some((word) => /(을|를|에|에서|로|와|과|고|며)$/.test(word)) }
function valueKey(text: string): string | null {
  const topic = topicOf(text)
  if (!topic) return null
  const property = topic.property.join(' ')
  if (!SINGLE_VALUED.test(property) && !(topic.owner.length && property && bareValue(topic.value))) return null
  return `${ownerWords(topic.owner).join(' ')}|${topic.property.filter((word) => !/^(새|정식|현재|최종)$/.test(word)).join(' ')}`
}
const topicKey = (text: string) => { const topic = topicOf(text); return topic ? [...topic.owner, ...topic.property].join(' ') : '' }
function respelled(a: string, b: string): boolean {
  const [one, other] = [a.split(' '), b.split(' ')]
  if (one.length < 3 || one.length !== other.length || topicKey(a) !== topicKey(b)) return false
  const differing = one.flatMap((word, i) => (word === other[i] ? [] : [[word.toLowerCase(), (other[i] ?? '').toLowerCase()] as const]))
  const [x, y] = differing[0] ?? ['', '']
  return differing.length === 1 && !/\d/.test(x + y) && Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))
}
// Dates as month/day; a line that lost its month to the old list-marker bug ("월 28일 …") matches any month.
const datesIn = (text: string) => [...text.matchAll(/(\d{1,2})월\s*(\d{1,2})일|(\d{1,2})\/(\d{1,2})(?!\d)|^()월\s*(\d{1,2})일/g)].map((m) => `${Number(m[1] ?? m[3]) || '*'}/${Number(m[2] ?? m[4] ?? m[6])}`)
const quotedIn = (text: string) => [...text.matchAll(/["“‘']([^"”’']{2,40})["”’']/g)].map((m) => (m[1] ?? '').toLowerCase())
const loose = (text: string) => normalizeFact(text).replace(/(입니다|이다|이에요|예요)$/, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

export function withoutResidue(raw: string): { text: string; gone: string[] } {
  const gone: string[] = []
  let text = raw.replace(NOT_BUT, (_whole, value: string) => { gone.push(/\d/.test(value) ? value : `"${value.replace(/["“”‘’']/g, '')}"`); return '' })
  const tail = /^(.*?)\s*\(([^()]*)\)$/.exec(text)
  const tailResidue = tail?.[2]?.split(/,\s*/).filter((part) => RESIDUE.test(part.trim())) ?? []
  if (tail && tailResidue.length) { gone.push(...tailResidue); text = tail[1] ?? '' }
  const clauses = text.split(/[,;]\s+/)
  const kept = clauses.filter((clause) => !RESIDUE.test(clause.trim()))
  if (kept.length < clauses.length) { gone.push(...clauses.filter((clause) => !kept.includes(clause))); text = kept.join(', ').replace(/이(고|며)$/, '이다') }
  return { text: text.trim(), gone }
}

// Takes one line into the kept ones: returns it without residue (or '' when nothing is left or it only
// says a kept line again), and removes the kept lines whose value it replaces.
function settleInto<T extends { text: string }>(kept: T[], raw: string): string {
  const { text, gone } = withoutResidue(raw)
  if (!text) return ''
  if (gone.length) {
    const named = gone.join('\n')
    const dates = datesIn(named).filter((date) => !datesIn(text).includes(date))
    const values = quotedIn(named).filter((value) => !text.toLowerCase().includes(value))
    for (let i = kept.length - 1; i >= 0; i--) {
      const old = kept[i]?.text ?? ''
      const holds = values.some((value) => old.toLowerCase().includes(value)) || datesIn(old).some((date) => dates.some((named) => named === date || (date.startsWith('*/') && named.endsWith(date.slice(1)))))
      if (holds && sameSubject(text, old)) kept.splice(i, 1)
    }
    if (kept.some((one) => loose(one.text) === loose(text))) return ''
  }
  const key = valueKey(text)
  for (let i = kept.length - 1; i >= 0; i--) {
    const old = kept[i]?.text ?? ''
    if (loose(old) !== loose(text) && ((key && valueKey(old) === key) || respelled(old, text))) kept.splice(i, 1)
  }
  return text
}

// keep_in_mind's "replaces": the kept lines a new fact takes the place of, named whole or by the old value alone.
// A value alone only takes a line about the same subject as one of the new facts.
export function replacedLines(known: readonly string[], facts: readonly string[], replaces: readonly string[]): string[] {
  const fresh = facts.map((fact) => withoutResidue(normalizeFact(fact)).text).filter(Boolean)
  return known.filter((line) => !fresh.some((fact) => loose(fact) === loose(line)) && replaces.some((named) => {
    const value = named.replace(/["“”‘’']/g, '').trim().toLowerCase()
    if (loose(named) === loose(line)) return true
    const holds = (value.length >= 2 && line.toLowerCase().includes(value)) || datesIn(named).some((date) => datesIn(line).includes(date))
    return holds && fresh.some((fact) => sameSubject(fact, line))
  }))
}

export function settleFacts<T extends { text: string }>(facts: readonly T[]): T[] {
  const kept: T[] = []
  for (const fact of facts) {
    const text = settleInto(kept, fact.text)
    if (text) kept.push(text === fact.text ? fact : { ...fact, text })
  }
  return kept
}


// The model's lines, kept only where they are facts: not NONE, not a
// restatement of something kept, never a secret.
export function parseFactLines(raw: string, known: readonly string[]): string[] {
  const seen = new Set(known.map((k) => normalizeFact(k).toLowerCase()))
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const fact = normalizeFact(line)
    if (!fact || /^none$/i.test(fact) || fact.length < 4) continue
    if (secretsIn(fact).length > 0 || notAFact(fact) || !withoutResidue(fact).text) continue
    const key = fact.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(fact)
  }
  return out
}

export function factScore(fact: BotFact, now: Date): number {
  const age = Math.max(0, now.getTime() - new Date(fact.touchedAt).getTime()) / DAY_MS
  return 0.5 ** (age / HALF_LIFE_DAYS)
}

interface MemoryChange {
  added: number
  touched: number
}

// A fact said again is the same fact with a fresh clock, never a second line.
// A changed value is a new line; the old one leaves through the extractor's "outdated:" line, keep_in_mind's "replaces",
// when the new line names what it replaces, or when both give the same single-valued property (a code name, a deadline).
export function recordFacts(paths: VaultPaths, botId: string, lines: string[], now = new Date()): Promise<MemoryChange> {
  return serialized(memoryPath(paths, botId), async () => {
    const file = await loadBotMemory(paths, botId)
    const stamp = now.toISOString()
    let added = 0
    let touched = 0
    for (const line of lines) {
      const text = settleInto(file.facts, normalizeFact(line))
      if (!text) continue
      const same = file.facts.find((f) => normalizeFact(f.text).toLowerCase() === text.toLowerCase())
      if (same) {
        same.touchedAt = stamp
        touched++
      } else {
        file.facts.push({ id: `f-${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`, text, at: stamp, touchedAt: stamp })
        added++
      }
    }
    file.turns++
    if (file.facts.length > DISK_CAP)
      file.facts = [...file.facts].sort((a, b) => factScore(b, now) - factScore(a, now)).slice(0, DISK_CAP)
    await saveBotMemory(paths, botId, file)
    return { added, touched }
  })
}

export async function forgetFact(paths: VaultPaths, botId: string, factId: string): Promise<void> {
  await serialized(memoryPath(paths, botId), async () => {
    const file = await loadBotMemory(paths, botId)
    file.facts = file.facts.filter((f) => f.id !== factId)
    await saveBotMemory(paths, botId, file)
  })
}

// Forgetting is by what was said, so a line forgotten in one comet also
// leaves the profile every comet shares.
export async function forgetFactText(paths: VaultPaths, botId: string, text: string): Promise<void> {
  const key = normalizeFact(text).toLowerCase()
  await serialized(memoryPath(paths, botId), async () => {
    const file = await loadBotMemory(paths, botId)
    const kept = file.facts.filter((f) => normalizeFact(f.text).toLowerCase() !== key)
    if (kept.length !== file.facts.length) await saveBotMemory(paths, botId, { ...file, facts: kept })
  })
  if (botId === PERSON_MEMORY) {
    const copies = await readdir(join(paths.cache, MEMORY_DIR)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    await Promise.all(copies.filter(name => name.endsWith('.json') && name !== `${PERSON_MEMORY}.json`).map(name => forgetFactText(paths, name.slice(0, -5), text)))
  }
}

// One reading of the person that every comet adds to and reads from, beside
// each comet's own: what one comet learns about how they work, the next knows.
export const PERSON_MEMORY = '_person'

// The fallback for a line the extractor did not mark: naming one of these makes it about the person and shared.
const IDENTITY_PHRASES = ['my name', 'their name', "person's name", 'preferred name', 'time zone', 'timezone', 'pronouns', '이름', '호칭', '시간대', '타임존'] as const

export function isIdentityFact(text: string): boolean {
  const lower = text.toLowerCase()
  return IDENTITY_PHRASES.some((phrase) => lower.includes(phrase))
}

const SCOPE_MARK = /^\s*(?:[-*•]\s*)?(everyone|this bot)\s*:\s*/i
const OUTDATED_MARK = /^\s*(?:[-*•]\s*)?outdated\s*:\s*/i
const FACT_LINE = /^\s*(?:[-*•]\s|none\s*$)/i
// The job asks for three lines; a reply far past that is an answer, not notes.
const FACT_LINES_MAX = 6

// A marked line goes where the extractor said; an unmarked one is shared only when it names who the person is.
// A reply that is not a list of facts (the model answered the chat instead) keeps nothing.
// `said` is the person's message: a line worded as an order is dropped unless they set that rule in it. A shared
// line about the app, a folder, a file or an archive is what the comet found out while working, not a fact about
// them, unless it is mostly their own words; every other fact about the person is kept whatever the language.
// shortcut: a fixed list of tooling nouns, words compared by stems; a tooling fact the person stated in another language than the line is dropped.
const TOOLING = /앱|폴더|파일|경로|디렉터리|보관함?|아카이브|workspace|\b(apps?|folders?|files?|paths?|director(y|ies)|archived?|archives?)\b|[~.]?\/[\w.-]+\//i
function personSaid(line: string, said: string): boolean {
  if (!TOOLING.test(line)) return true
  const theirs = new Set(stems(said))
  const mine = stems(line).filter((stem) => !STOP.has(stem))
  return mine.filter((stem) => theirs.has(stem)).length * 2 > mine.length
}
export function scopeFacts(raw: string, known: readonly string[], said = ''): { shared: string[]; own: string[]; outdated?: string[] } {
  const written = raw.split('\n').filter((line) => line.trim())
  if (written.length > FACT_LINES_MAX || written.some((line) => !FACT_LINE.test(line) && !SCOPE_MARK.test(line) && !OUTDATED_MARK.test(line))) return { shared: [], own: [] }
  // Only a line that is really kept can be called outdated (quotes and spacing aside), and only by a line this reply keeps about the same subject.
  const named = written.filter((line) => OUTDATED_MARK.test(line)).map((line) => loose(line.replace(OUTDATED_MARK, '')))
  const candidates = known.map(normalizeFact).filter((line) => named.includes(loose(line)))
  const lines = written.filter((line) => !OUTDATED_MARK.test(line)).map((line) => {
    const mark = SCOPE_MARK.exec(line)
    const text = mark ? line.slice(mark[0].length) : line
    return { text, shared: mark ? mark[1]?.toLowerCase() === 'everyone' : isIdentityFact(text) }
  }).filter((line) => !unaskedRule(line.text, said) && (!line.shared || personSaid(line.text, said)))
  const shared = parseFactLines(lines.filter((l) => l.shared).map((l) => l.text).join('\n'), known)
  const own = parseFactLines(lines.filter((l) => !l.shared).map((l) => l.text).join('\n'), [...known, ...shared])
  const outdated = candidates.filter((line) => [...shared, ...own].some((fresh) => sameSubject(withoutResidue(fresh).text, line)))
  return { shared, own, ...(outdated.length ? { outdated } : {}) }
}

// Shared and own facts as one list, each line once, the fresher clock kept.
export function mergeMemory(...files: BotMemoryFile[]): BotMemoryFile {
  const byText = new Map<string, BotFact>()
  let shared = 0
  files.forEach((file, index) => {
    for (const fact of file.facts) {
      const key = normalizeFact(fact.text).toLowerCase()
      const prior = byText.get(key)
      if (!prior || prior.touchedAt < fact.touchedAt) byText.set(key, fact)
    }
    if (index === 0) shared = byText.size
  })
  return { facts: [...byText.values()], turns: files.reduce((sum, file) => sum + file.turns, 0), shared }
}

export async function forgetBotMemory(paths: VaultPaths, botId: string): Promise<void> {
  await rm(memoryPath(paths, botId), { force: true }).catch(() => undefined)
}

const memoryLine = (f: BotFact) => `- (${f.at.slice(0, 10)}) ${f.text}`.replace(/\s+/g, ' ')

// The facts that ride in the prompt: shared facts first, then the comet's
// own, each layer the freshest that fit its own budget, and each layer in the
// order its facts were first written.
export function selectForPrompt(file: BotMemoryFile, now = new Date()): BotFact[] {
  const split = file.shared ?? file.facts.length
  const byScore = (facts: BotFact[]) => [...facts].sort((a, b) => factScore(b, now) - factScore(a, now))
  const layers = [[file.facts.slice(0, split), MEMORY_BUDGET.shared], [file.facts.slice(split), MEMORY_BUDGET.own]] as const
  return layers.flatMap(([layer, budget]) => {
    const chosen: BotFact[] = []
    let chars = -1
    for (const fact of byScore(layer)) {
      const next = chars + 1 + memoryLine(fact).length
      if (chosen.length >= budget.lines || next > budget.chars) continue
      chosen.push(fact)
      chars = next
    }
    return chosen.sort((a, b) => a.at.localeCompare(b.at))
  })
}

export function renderMemory(file: BotMemoryFile, now = new Date()): string {
  return selectForPrompt(file, now).map(memoryLine).join('\n')
}

// The one prompt of the feature. Short on purpose: the model that reads it
// answers in a few hundred tokens and must not be asked to classify, diff
// or copy - only to notice what is worth keeping.
export const REMEMBER_TOKENS = 160
export function rememberPrompt(exchange: { user: string; answer: string; previous?: string; places?: readonly string[] }, known: readonly string[]): string {
  return [
    'JOB: COMET-REMEMBER',
    'You keep short notes about the person you assist. From the exchange below, write only what is worth remembering in later, unrelated conversations: who they are, how they like to be helped, ongoing work, decisions, dates.',
    'When the person corrects your previous answer or says how they want something done from now on, keep the rule they gave, stated so it applies next time. How to word or format this one answer is not a rule; neither is a suggestion of yours they did not take up.',
    'A value given only to be repeated, formatted or tested is not a fact. When they change a fact in "Already kept", write the new fact alone, then a line "- outdated: " with the kept line copied exactly; never write the old or wrong value in a fact, not even to say it is wrong or replaced.',
    'Only what the person told you or decided: what you found in a file, what the app can or cannot do and what you did this turn are not facts about them.',
    'Where their work lives is worth keeping: a page below that held what they asked for, as what it is for plus its address.',
    'Begin each line with "- everyone: " for a fact about the person (who they are, how they like things done, tools, accounts, places, people they work with, standing decisions, ongoing projects with goal and status, e.g. "결정: …", "진행 중인 프로젝트: …") or "- this bot: " only for this assistant\'s own job (its site, its routine details).',
    'Rules: at most 3 lines, each a complete short sentence in their language. Nothing that is already in "Already kept". Nothing about this one request itself. No passwords or keys. If nothing is worth keeping, write only: NONE',
    '',
    'Already kept:',
    ...(known.length ? known.map((k) => `- ${k}`) : ['(nothing yet)']),
    '',
    ...(exchange.previous ? [`Your previous answer: ${withoutReplies(exchange.previous).slice(0, 400)}`] : []),
    `Person: ${exchange.user.slice(0, 600)}`,
    `You answered: ${withoutReplies(exchange.answer).slice(0, 600)}`,
    ...(exchange.places?.length ? ['Pages the work reached:', ...exchange.places.slice(0, 6).map((place) => `- ${place}`)] : []),
  ].join('\n')
}

/** Every memory kept on disk, by id: bot ids and the shared ones (`_person`, `_team`). */
export async function memoryIds(paths: VaultPaths): Promise<string[]> {
  return (await readdir(join(paths.cache, MEMORY_DIR)).catch(() => [])).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
}
