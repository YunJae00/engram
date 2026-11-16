import type { AgentTool } from './agent-loop.js'
import { formatAsk, parseAsk } from './ask.js'
import { communityPost } from './search-template.js'
import { logTask, MEMBER_RESULT_CHARS, TEAM_MAX_DEPTH, TEAM_MAX_HIRES, type DelegatedTask, type TaskTeam, type TeamMember } from './delegated-tasks.js'

// The hidden team: the lead hires members for the parts of a job, a member may hire its own helpers.
// Rules and text live here; pool slots, sessions and abort live in the desktop team-runner.

export const TEAM_TOKEN_RESERVE = 45_000
export const HIRE_MAX_PER_CALL = 4
export const TEAM_PLAN_OK = ['이대로 진행', 'Go ahead as planned']
export const TEAM_PLAN_FIX = ['고칠 점 말할게', 'I want changes']
export const TEAM_PLAN_YES = /^\s*(이대로 진행(해|해줘|해주세요)?|go ahead as planned|go ahead|응|네|예|좋아|좋아요|진행해|진행해줘|yes|ok|okay)\s*[.!~]*\s*$/i
const CODING = /코딩|코드|개발|프로그램|앱\s*(을|를)?\s*만들|웹\s*사이트|\b(cod(e|ing)|develop\w*|implement\w*|program\w*|app|website|software|repo(sitory)?)\b/i
export const MEMBER_RULE = 'Do only your part, and only what it asks: no optional extras. Never wait with a shell sleep or by polling memory; when a tool cannot run now, use another source or report what you have. You may hire helpers only if your part clearly has separable pieces; review what they return before you report. Report the result in at most 2000 characters, then the files you made by path. You do not talk to the person: when only they can answer, call ask_person once and stop.'
export const MEMBER_BLOCKED = /^(new_bot|agents|assign|agents_now|schedule|keep_in_mind|keep_how_to|offer_study|study_findings|report_result_check)$/
export const SCREEN_TOOL = /^(app_|desktop_|open_app|look_desktop|read_desktop|list_windows|excel_|word_|ppt_|outlook_|compose_live_document|edit_live_document|read_live_document)/
const TOKEN_REFUSAL = 'The task token budget is nearly used. Do not hire. Finish with what exists and close with what is done, what is missing and what comes next.'
const PLAN_FIRST = `Big team plan: nothing was hired. Show the plan to the person once before hiring: call ask_person with the members and what each delivers, options ["${TEAM_PLAN_OK[0]}", "${TEAM_PLAN_FIX[0]}"] in their language, and end this turn there. Hire after they agree in their next message. Their OK covers the plan only: sends, posts, purchases and deletions are still asked one by one.`
const PARTIAL_NOTE = 'Some members reported and some need the person (their "ask"). Do not end on the question alone: review the members that reported, give the person the combined answer from them now, say which part is missing, and close with the waiting member\'s question in the person\'s language. Leave the waiting member unreviewed; when the person answers, pass it with review_member({id, ok:false, note:<answer>}).'
// A lookup member that finished on its own and names its sources is accepted as it is: the lead reads it while merging. grokbar: three review_member rounds cost ~10 s.
export const AUTO_REVIEW = 'auto: sourced lookup'
const ACCEPTED_NOTE = 'Members with accepted true are sourced lookups, already accepted and released: do not call review_member for them. Report in one merged answer: several items go in one table, each row with the address it came from.'
// grokbar c3 R1/T1: the merged answer opened with "세 봇이 조사한 … 취합해서 알려드릴게요." and the judge read it as a status report.
export const MERGED_SHAPE = 'The merged answer reads like a colleague\'s message: one friendly lead sentence that already gives the gist, then one table (item | what was found | source; when the person compares named points such as price and release date, one column per point instead, every cell a short value with its figure), and nothing after the table. When the person asked for the work to be split (bots, 나눠서, 각각 따로), that lead sentence, or one short sentence before the table, says in a few words how it was split, from "split" in this result: how many took part, and that something they added mid-work got one more ("셋이 하나씩 맡아 알아봤어요.", "대구는 한 명 더 붙여서 넷이 나눠 봤어요."); never who is still working ("작업 중"), a member id or a role label ("대구날씨"). No other sentence about bots, members or collecting results, no closing question or offer, and no word about time, limits, attempts or what failed. A member that found nothing keeps its row, with a plain "못 찾았어요" in the person\'s language; a value that is not out yet says so and keeps the labeled figure its member reported ("미발표, 예상 130만 원대").'
// grokbar B6: sources came back as site names ("네이버 날씨 검색") and the merged answer had 0 links in R1, R2, R3 and T1.
const SOURCES_NOTE = 'sources lists the pages each member actually read. In the merged table the last cell of every row is that member\'s source as a markdown link, [site name](address), with the address copied exactly from sources and the link text the site\'s or publication\'s own name (네이버 날씨, Apple, 삼성전자 뉴스룸, 연합뉴스), a blog or café post by its own title, never "네이버 블로그" or "네이버 카페", never a member\'s role or name; never a site name alone. A row names a member only when the person named the members themselves ("지민, 서연한테 나눠서"): then its first cell is the item with that name in parentheses.'
const STEER_NOTE = 'The person wrote to you while the team worked; their words follow this result. Members with state working keep going. If their words add or change a part, call hire_members now for that part only; with nothing to add, call hire_members with members [] to wait. Either call also returns the members still working. Then give one answer that covers everything.'
const REVIEW_NOTE = 'Review each member with review_member before you report, all in one step. A member that stopped at its time limit handed back what it had: accept it and say what is missing; a lookup member is never re-run. A failed member delivered nothing: say that part is missing, or redo it once if the person asked for it. A member that needs the person is asked in your thread for you; when they answer, pass the answer with review_member({id, ok:false, note:<answer>}).'

// A lookup member (research, fact check, reading): a faster model, reading tools only, and a time box. perf146: three opus members with 65 tools
// each took 118-213 s on a weather lookup, one of them 90 s on an optional extra, and the lead waits for the slowest.
export const LOOKUP_TOOLS = new Set(['search_web', 'read_pages', 'open_page', 'read_open_page', 'look', 'reveal', 'search_memory', 'read_note', 'search_chats', 'ask_person'])
// After the soft limit no new tool call starts and the member reports what it has; at the hard limit it is stopped with what it wrote so far.
// perf146 r3: at 60 s / 80 s / 12 calls the members took 71-76 s of a 102 s answer; the lead waits for the slowest, so these bound the team.
// grokbar: at 40 s / 55 s / 10 calls three members took 36 s of a 71 s answer against a 35 s bar for the whole answer.
// grokbar B6: at 18 s / 24 s / 6 calls the slowest member still took 22-24 s of a 38 s answer (plan 8 s, review 4 s, merge 4 s). A member that
// answers from its one search is back in 10 s; the ones that went on to open articles read 0 of 2 pages and were cut with nothing written.
export const LOOKUP_SOFT_MS = 8_000
export const LOOKUP_HARD_MS = 15_000
export const LOOKUP_MAX_CALLS = 4
// grokbar c3 R2/R3: members spent their ten seconds thinking between a search and a page that was then refused, and reported "소스 접근 실패".
// The search now hands over the results themselves (title, address, words, date), so one search is the normal case.
// c5 R2/C3: a member whose one search held no figure reported "미발표, 전작보다 인상 예상" at 3 s of its 8; "Search once" and "when the
// results hold one" let it. It now looks once more inside the same limits, and a price that is not out still carries a number.
export const LOOKUP_RULE = 'You only look things up: you have reading tools and about ten seconds, enough for one search and, when that does not hold the answer, one more search or one page. Search first with the query in the person\'s language: the results come as a list, each with its title, its own address, what it says and its date. When they hold what the brief asks, report at once from them, each fact with the address of the result it came from (the maker\'s own page or a news article when the list has one, before a café or blog post); open a page only for a number none of them shows. When the first results do not hold what the brief asks (no figure, no date, nothing about that product or company), search once more in other words before you report - the maker\'s or the product\'s English name ("Galaxy S27 price", "Linear changelog"), or a news search (kind "news") - and never a third time. A source is named by its site or publication (삼성전자 뉴스룸, 연합뉴스), a blog or café post by its own title: never "네이버 블로그" or "네이버 카페". When the brief names what to find about a thing (its price, its release date), report each on a line of its own, "가격: …", "출시일: …", each a short value with a figure in it. A date is written as the results give it (11월 10일). Report in the person\'s language, in plain polite sentences (in Korean the -요 form): the facts first, each with its address (the page itself, never a search-results address, unless the fact was read on the results page itself). A figure read from the results page\'s own box (weather, a stock quote, a rate, a score) is cited to that service by name with the results page\'s address, the one after "results for … at" - [네이버 날씨](that address), [네이버 증권](that address) - never to a blog or any other result you did not take it from. A price that is not announced yet says so and still gives a number with its currency, labeled 예상 or 전작: the reported expectation ("미발표, 예상 130만 원대") or the previous model\'s launch price ("미발표, 전작 S26 115만 원"); a date the same way, the expected month with its year ("미발표, 2027년 2월 예상"). That number comes from a result or is the previous model\'s known launch price, labeled as what it is: never a number of your own, and never a line with no number in it ("전작보다 인상 예상" alone is not a price); never write about time, limits, attempts, tools, pages that did not open or what you failed to do. A page that wants a sign-in or a robot check is left alone, never worked around: read another source. If your part needs anything other than reading, say so in one line and stop.'

// A lookup member reads public sources, and its tab closes when it ends, so a page that wants the person (a sign-in, a robot check) cannot be
// handed over from it: the page is left unread and unpassed, another source is read, and the lead reports the gap (perf146 r2: one search page's
// robot check ended a three-city weather team on "로그인이나 확인을 마치고 알려줘" with no page open). Only the member's own ask_person asks.
export function skipWalls(tool: AgentTool): AgentTool {
  if (tool.name === 'ask_person') return tool
  const skip = (text: string, args: Record<string, unknown>): string => parseAsk(text)
    ? `${typeof args['url'] === 'string' ? args['url'] : 'That source'} needs the person (a sign-in, a robot check, or a setting only they have) and was not read. Do not ask about it and do not try to get past it: read another source (open_page on a site that holds the answer). If nothing else has it, report what you have and name this as the missing part.`
    : text
  return { ...tool, run: async (args, context) => skip(await tool.run(args, context), args), ...(tool.runRich ? { runRich: async (args, context) => { const out = await tool.runRich!(args, context); return { ...out, text: skip(out.text, args) } } } : {}) }
}

export interface MemberOutcome { answer: string; asked?: boolean; budgetExhausted?: boolean; timedOut?: boolean; error?: string; /** Pages it read (keepSources). */ sources?: string[]; /** What it was given to read (keepRead). */ read?: string }
export interface MemberRedo { note: string; answered?: boolean }

export interface TeamHost {
  // The caller's member id; null for the lead.
  self: string | null
  load(): Promise<DelegatedTask | undefined>
  // Resolves when the person says something to the lead while it waits for members; rejects or never settles otherwise.
  steered?(signal: AbortSignal): Promise<void>
  // One atomic task write; returns work's value, undefined when there is no running task.
  change<T>(work: (task: DelegatedTask) => T): Promise<T | undefined>
  // Runs these members to an end state and persists it.
  run(ids: string[], signal?: AbortSignal, redo?: MemberRedo): Promise<void>
  // Closes sessions, state -> released.
  release(ids: string[]): Promise<void>
  live(id: string): boolean
  tokensLeft(): Promise<number>
  // The message that started the lead's current turn.
  personSaid(): string
}

const newTeam = (): TaskTeam => ({ members: [], hires: 0, maxHires: TEAM_MAX_HIRES, maxDepth: TEAM_MAX_DEPTH, big: false })
const cut = (text: string, max: number) => text.length > max ? text.slice(0, max) : text
const DOC_FILE = /(?:^|[\s("'`])((?:[~.]?\/|[A-Za-z]:\\)?[^\s"'`()<>]+\.(?:pdf|docx?|xlsx?|pptx?|csv|md|txt|html?|json|png|jpe?g|zip))(?=$|[\s)"'`.,])/gi

// A coding job, many members, or the caller saying so: the person sees the plan before anyone is hired.
export function bigPlan(goal: string, members: readonly { role: string; brief: string }[], flagged: boolean): boolean {
  return flagged || members.length > 3 || CODING.test([goal, ...members.flatMap(m => [m.role, m.brief])].join('\n'))
}

export const unreviewed = (team: TaskTeam | undefined, parentId: string | null): TeamMember[] => (team?.members ?? []).filter(m => m.parentId === parentId && m.state !== 'released')
// A task with a team is done only after its result check passed.
export const teamUnverified = (task: DelegatedTask): boolean => (task.team?.members.length ?? 0) > 0 && task.verified !== true
// Every member must have been reviewed (and so released) by its parent before the task is done.
export function teamReviewIssue(task: DelegatedTask): string {
  const open = (task.team?.members ?? []).filter(m => m.state !== 'released' || !m.review)
  return open.length ? `Team members not reviewed yet: ${open.map(m => `${m.role} (${m.id})`).join(', ')}. Call review_member for each before reporting done.` : ''
}

export function failOnRestart(team: TaskTeam, at: string, why = 'the app restarted while this member was working.'): string[] {
  const lost = team.members.filter(m => ['hired', 'working', 'waiting', 'reviewing'].includes(m.state))
  for (const m of lost) { m.state = 'failed'; m.result = `Failed: ${why}`; m.finishedAt = at }
  return lost.map(m => m.id)
}

export function releaseAll(team: TaskTeam, at: string): string[] {
  const open = team.members.filter(m => m.state !== 'released')
  for (const m of open) { m.state = 'released'; m.finishedAt ??= at }
  return open.map(m => m.sessionKey)
}

// One line that only says what the member is about to do ("지금 검색하겠습니다."): cut off there, it reported nothing.
const PROGRESS_ONLY = /^(?:[^\n]{0,120}(?:겠습니다|겠어요|[할볼릴]게요|하는 중(?:입니다|이에요)?)|(?:I['’]ll|I will|I am going to|I'm going to|Let me|Searching|Looking|Checking)\b[^\n]{0,120})[.!…\s]*$/i
// A results page is where a member searched, not where the fact is; a wall or an error page answered nothing.
const SEARCH_PAGE = /^https?:\/\/(?:[^/\s]*\bsearch\.|[^\s?#]*\/(?:search|results)\b|\S*[?&](?:q|query|search_query|wd|keyword)=)/i
const WALLED = /로봇|캡차|자동\s?입력|비정상적인 (?:트래픽|접근)|접근이?\s?(?:거부|차단|제한)|차단(?:되|됐|당)|오류(?:가|를)?\s?(?:발생|났|나서)|에러|페이지를 찾을 수 없|열리지 않|(?:열|읽|찾|확인할|가져올|접속할) 수 ?(?:가 )?없|(?:읽|찾|확인하|가져오|접속하)지 못|실패|\b(?:robot|captcha|unusual traffic|access denied|forbidden|blocked|not found|error|failed|could ?n[o']t|cannot|can't|unable to|timed out)\b/i
// grokbar review r1: "지금 검색하겠습니다. https://search.naver.com/…" was accepted for its link alone. A member answered its brief
// when, the links and the "about to do" lines taken out, facts are left, nothing in it reports a wall or a failure, and a source is a page of its own.
// shortcut: wording only, no model reads the brief against the answer; the lead still reads every result while merging.
// read: the pages it is known to have read (keepSources). A weather or price lookup is answered from the results page itself, so its only
// address is a search page; the read is then the evidence, not the link (grokbar stack-1 R1/T1: every such member cost a review round, ~5 s).
export function answeredLookup(answer: string, read: readonly string[] = []): boolean {
  const links = answer.match(/https?:\/\/[^\s)\]>"']+/g) ?? []
  if (!links.some(link => !SEARCH_PAGE.test(link)) && !read.length || WALLED.test(answer)) return false
  const said = answer.replace(/https?:\/\/[^\s)\]>"']+/g, ' ').split(/(?<=[.!?…。])\s+|\n+/).filter(part => part.trim() && !PROGRESS_ONLY.test(part.trim())).join(' ').replace(/[\s\p{P}\p{S}]+/gu, '')
  return said.length >= 30 || /\d/.test(said) && said.length >= 4
}
const SOURCES_MAX = 3
// The pages a lookup member read are kept as it reads them, whatever its words say: a page it opened, the pages of a batch that were
// ready, and the results page of a search that ran. A wall, a refusal or a failed read is no source.
export function keepSources(tool: AgentTool, seen: Set<string>): AgentTool {
  const note = (args: Record<string, unknown>, out: string): void => {
    try {
      if (tool.name === 'search_web') { const at = /^results for "[^\n]*" at (https?:\/\/\S+) \(DATA/.exec(out)?.[1]; if (at) seen.add(at) }
      else if (tool.name === 'open_page') { if (out.startsWith('page "') && typeof args['url'] === 'string' && /^https?:\/\//i.test(args['url'])) seen.add(args['url']) }
      else if (tool.name === 'read_pages') for (const page of (JSON.parse(out.replace(/^that did not work: /, '')) as { pages?: { url?: unknown; ready?: unknown }[] }).pages ?? []) if (page.ready === true && typeof page.url === 'string') seen.add(page.url)
    } catch { /* An output that is not a report names no source. */ }
  }
  if (!['search_web', 'open_page', 'read_pages'].includes(tool.name)) return tool
  return { ...tool, run: async (args, context) => { const out = await tool.run(args, context); note(args, out); return out }, ...(tool.runRich ? { runRich: async (args, context) => { const out = await tool.runRich!(args, context); note(args, out.text); return out } } : {}) }
}
// A page of its own comes before the results page it was found on.
const sourcesOf = (read: readonly string[]): string[] => [...new Set(read)].sort((a, b) => Number(SEARCH_PAGE.test(a)) - Number(SEARCH_PAGE.test(b))).slice(0, SOURCES_MAX)

// The merged answer names every member's source as a link, in that member's own row. The lead is told to put it there; a row it left
// with a site name alone ("네이버 날씨 검색") is repaired here: the row is matched to the one member whose role or brief names its first
// cell, and its last cell becomes the link (a source column) or gains one. A member no row could take gets a closing line instead.
// grokbar B6 r2: the closing line alone left the 부산 and 제주 rows of R1 without a link.
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/
export function citeMembers(answer: string, members: readonly TeamMember[], korean = false): string {
  if (!answer.trim()) return answer
  const cited = members.filter(m => m.sources?.length && m.state !== 'failed')
  const href = (m: TeamMember): string => m.sources![0]!.replace(/\)/g, '%29').replace(/ /g, '%20')
  // Only someone on the person's team is named in a row ("노션(지민)"); a bot made for the job has no name the person knows (c3 R1: "서울 (서울날씨봇)").
  const name = (m: TeamMember): string => m.botId ? m.role.replace(/[[\]|]/g, '').trim() : ''
  const lines = answer.split('\n')
  let sourceColumn = false
  for (const [i, line] of lines.entries()) {
    if (!/^\s*\|.*\|\s*$/.test(line) || TABLE_RULE.test(line)) continue
    const cells = line.trim().slice(1, -1).split('|').map(cell => cell.trim())
    if (TABLE_RULE.test(lines[i + 1] ?? '')) { sourceColumn = /출처|링크|source|link/i.test(cells.at(-1)!); continue }
    const words = cells[0]!.replace(/[*_`]/g, '').split(/[\s(),/·]+/).filter(word => word.length >= 2)
    const scored = members.map(m => ({ m, hits: words.filter(word => `${m.role} ${m.brief}`.includes(word)).length })).filter(one => one.hits).sort((x, y) => y.hits - x.hits)
    if (!scored.length || scored[1]?.hits === scored[0]!.hits) continue
    const own = scored[0]!.m
    // grokbar B6 r3: every row says whose report it is, "서울(서울 날씨)" as "노션(김대리)"; a row with a link and no name was unattributed.
    if (name(own) && !line.includes(name(own))) cells[0] = `${cells[0]}(${name(own)})`
    if (!/https?:\/\//.test(line)) {
      const last = cells.at(-1)!.replace(/[[\]]/g, ''), label = sourceColumn || cells.length === 1
      // c5a r3: a source cell that only names the place ("네이버 블로그") is not kept: the post its member linked by title takes it, else the member's page under its own name.
      const vague = label && PLACE.test(last.trim()), post = vague ? [...linked(own.result ?? '')].find(([url]) => communityPost(url)) : undefined
      if (post) cells[cells.length - 1] = `[${post[1]}](${post[0]})`
      else if (cited.includes(own)) cells[cells.length - 1] = label ? `[${(vague ? '' : last.replace(/^[-–—\s]*$/, '')) || siteName(own.sources![0]!, korean)}](${href(own)})` : `${cells.at(-1)} [${korean ? '출처' : 'source'}](${href(own)})`
      else if (vague) cells[cells.length - 1] = postWord(!/카페|caf/i.test(last), korean)
    }
    lines[i] = `| ${cells.join(' | ')} |`
  }
  // The same for a link the lead wrote itself: "[네이버 블로그](…)" takes the title a member gave that address, else the address's own name.
  const titles = new Map(members.flatMap(m => [...linked(m.result ?? '')]))
  const fixed = lines.join('\n').replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (whole, text: string, url: string) => PLACE.test(text.trim()) ? `[${titles.get(url) ?? siteName(url, korean)}](${url})` : whole)
  // stack-3 (c3a run, R1/R2): a row that linked the page its member's own result named still counted as uncited, because that member had
  // only searched; the answer closed with "출처: 네이버 검색 · 네이버 검색" under a table that already linked every row.
  const named = (m: TeamMember): string[] => (m.result?.match(/https?:\/\/[^\s)\]>"'|]+/g) ?? []).map(url => url.replace(/[.,;:!?]+$/, ''))
  const missing = cited.filter(m => !m.sources!.some(url => fixed.includes(url)) && !fixed.includes(href(m)) && !named(m).some(url => fixed.includes(url)))
  if (!missing.length) return fixed
  // grokbar c3 R2: "출처: iPhone18 · GalaxyS27 · Pixel11" - the link text is the site's name, never a member's role.
  return `${fixed.trimEnd()}\n\n${korean ? '출처' : 'Sources'}: ${[...new Map(missing.map(m => [href(m), `[${siteName(m.sources![0]!, korean)}](${href(m)})`])).values()].join(' · ')}`
}
// c5 R2 / c5a r3: where anyone posts is not a source's name ("네이버 블로그", "네이버 카페"). A post is named by its own title when a member
// linked it by one; the host has only the address otherwise, so it says what it is ("블로그 글").
// shortcut: the title comes from a member's own "[title](address)" only; keep each read page's title with its address (keepSources) if that proves too rare.
const PLACE = /^(?:(?:네이버|다음|naver|daum)\s?)?(?:블로그|카페|포스트|blog|caf[eé]|post)$|^(?:티스토리|브런치|tistory|brunch)$/i
const postWord = (blog: boolean, korean: boolean): string => korean ? (blog ? '블로그 글' : '커뮤니티 글') : blog ? 'blog post' : 'forum post'
const linked = (text: string): Map<string, string> => new Map([...text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)].filter(([, title]) => !PLACE.test(title!.trim())).map(([, title, url]) => [url!, title!.replace(/\|/g, ' ').trim().slice(0, 60)]))
// What a person calls the site an address is on: "네이버 검색", "apple.com".
const SITES: [RegExp, string, string][] = [[/(^|\.)naver\.com$/, '네이버', 'Naver'], [/(^|\.)daum\.net$/, '다음', 'Daum'], [/(^|\.)google\.[a-z.]+$/, '구글', 'Google'], [/(^|\.)bing\.com$/, 'Bing', 'Bing']]
export function siteName(url: string, korean = false): string {
  let host: string
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { return url }
  if (communityPost(url) && !SEARCH_PAGE.test(url)) return postWord(/blog|post\.|tistory|brunch|velog|medium/.test(host), korean)
  const known = SITES.find(([hosts]) => hosts.test(host))
  if (!known) return host
  if (!SEARCH_PAGE.test(url)) return known[korean ? 1 : 2]
  // c4 R1/L1: a figure from the results page\'s own box is cited to the service that box is ("네이버 날씨"), not to "네이버 검색".
  // shortcut: only Naver's boxes are named, by the words searched; another engine stays "… 검색".
  let asked = ''
  try { asked = known[2] === 'Naver' ? new URL(url).searchParams.get('query') ?? '' : '' } catch { /* stays a search */ }
  const box = BOXES.find(([words]) => words.test(asked))
  return `${known[korean ? 1 : 2]} ${box ? box[korean ? 1 : 2] : korean ? '검색' : 'search'}`
}
const BOXES: [RegExp, string, string][] = [[/날씨|기온|강수|미세\s?먼지|weather|forecast/i, '날씨', 'Weather'], [/주가|주식|시세|증시|stock|share price/i, '증권', 'Finance'], [/환율|exchange rate/i, '금융', 'Finance']]
// c4 L3: the answer's only link was a result the turn never opened, on a host that does not answer. Each address shown that this turn did not
// itself load is asked once, all together, inside one short budget and with no retry. One that does not answer gives way to the page the
// turn read; with none (or with that page already linked) the link goes and its name stays as plain words. One still unanswered at the
// budget is kept: the check never holds the answer longer, never fails it and never makes up an address.
export const LINK_CHECK_MS = 1_500
// c4 r2: 401, 403 and 429 were kept as "opens for a person"; the link check that grades the answer counts every 4xx and 5xx as dead.
export const linkAnswers = (status: number): boolean => status >= 200 && status < 400
// stack-4: the check is a request the host makes to an address a page's words can put in an answer. One on this machine or its own network is
// never asked (it is kept as written): a GET there could reach a local service.
// shortcut: by the address as written only; a public name that resolves to a private address is still asked. Resolve first if that matters.
export const localAddress = (url: string): boolean => { try { const host = new URL(url).hostname.toLowerCase(); return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.startsWith('[') || /^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) || !host.includes('.') } catch { return true } }
const ADDRESS = /https?:\/\/[^\s)\]>"'|]+/g
// The same address reads differently once its spaces and Korean are escaped for a link.
const plainAddress = (url: string): string => { try { return decodeURI(url) } catch { return url } }
const unloaded = (text: string, read: readonly string[]): string[] => { const loaded = new Set(read.map(plainAddress)); return [...new Set((text.match(ADDRESS) ?? []).map(url => url.replace(/[.,;:!?]+$/, '')))].filter(url => !loaded.has(plainAddress(url))) }
async function deadOf(shown: readonly string[], alive: (url: string, signal: AbortSignal) => Promise<boolean>, ms: number): Promise<string[]> {
  if (!shown.length) return []
  const limit = new AbortController(), timer = setTimeout(() => limit.abort(), ms)
  const late = new Promise<boolean>(resolve => limit.signal.addEventListener('abort', () => resolve(true), { once: true }))
  // A check that throws at the budget was slow, not dead.
  const dead = (await Promise.all(shown.map(async url => (await Promise.race([Promise.resolve().then(() => alive(url, limit.signal)).catch(() => limit.signal.aborted), late])) ? '' : url))).filter(Boolean)
  clearTimeout(timer)
  limit.abort()
  return dead
}
function withoutDead(answer: string, dead: readonly string[], read: readonly string[], korean: boolean, named = true): string {
  const own = sourcesOf(read)[0], literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let out = answer
  for (const url of dead) {
    const swap = own && !plainAddress(out).includes(plainAddress(own)) ? own.replace(/\)/g, '%29').replace(/ /g, '%20') : ''
    out = out.replace(new RegExp(`\\[([^\\]\\n]*)\\]\\(${literal(url)}[.,;:!?]*\\)`, 'g'), (_whole, name: string) => swap ? `[${siteName(own!, korean)}](${swap})` : named ? name : '')
      .replace(new RegExp(`${literal(url)}(?![^\\s)\\]>"'|])`, 'g'), swap)
  }
  return out
}
// swap: the pages a dead link may give way to (a team answer of several teammates passes none: a row never gets another teammate's page).
export async function liveLinks(answer: string, read: readonly string[], alive: (url: string, signal: AbortSignal) => Promise<boolean>, korean = false, ms = LINK_CHECK_MS, swap: readonly string[] = read): Promise<string> {
  return withoutDead(answer, await deadOf(unloaded(answer, read), alive, ms), swap, korean)
}
// c4 r2: the citations were finished after the check, so a link citeMembers put in a row or a closing line was never asked. `cite` finishes
// the citations; every address it can add (seen by citing the answer with its own addresses taken out) is asked in the same one pass as the
// answer's own. A dead address is taken out before citing, so its row gets its member's page, and again after, so a member's dead page goes too.
export async function liveCited(answer: string, read: readonly string[], cite: (answer: string) => Promise<string> | string, alive: (url: string, signal: AbortSignal) => Promise<boolean>, korean = false, ms = LINK_CHECK_MS): Promise<string> {
  const dead = await deadOf(unloaded(`${answer}\n${await cite(answer.replace(ADDRESS, ''))}`, read), alive, ms)
  const row = /^\s*\|.*\|\s*$/, cells = (line: string): string[] => line.trim().slice(1, -1).split('|').map(cell => cell.trim())
  const was = withoutDead(answer, dead, read, korean).split('\n'), bare = withoutDead(answer, dead, read, korean, false).split('\n')
  // c4 r3: a dead link's name ("블로그") became the name of the member's page that took its place. In a table row the dead link goes with its
  // name before citing, so the page put there is named as itself; a row that got no live page keeps the source cell it had, as plain words.
  const rows = (await cite(was.map((line, i) => row.test(line) ? bare[i]! : line).join('\n'))).split('\n').map((line, i) => {
    const had = was[i]
    if (had === undefined || !row.test(had) || !row.test(line)) return line
    return dead.some(url => line.includes(url) && !had.includes(url)) || bare[i] !== had && !/https?:\/\//.test(cells(line).at(-1)!) ? `| ${[...cells(line).slice(0, -1), cells(had).at(-1)!].join(' | ')} |` : line
  })
  const out = withoutDead(rows.join('\n'), dead, read, korean)
  // A closing source line lists links only: a member's dead page leaves no bare name there.
  return out.replace(/\n\n(출처|Sources): ([^\n]*)$/, (_whole, label: string, items: string) => { const kept = items.split(' · ').filter(item => /\]\(https?:\/\//.test(item)); return kept.length ? `\n\n${label}: ${kept.join(' · ')}` : '' })
}
// A lone lookup's answer says where it was read. grokbar stack-1 L1, L4: "출처: 네이버 환율 검색 결과" with no address.
// c3 L2/L4: "출처: bing.com" read like a printout. An answer with no link gets one named link, after its last sentence; an answer that links a page is left alone.
export function citeOwn(answer: string, read: readonly string[], korean = false): string {
  // c5 L2: the stored answer ends with its suggested replies, so the link was never "at the end" and stayed on a line of its own ("네이버 증권").
  // The replies are set aside, the answer is cited as if they were not there, and they go back as they were.
  const replies = /\s*```replies[^]*$/.exec(answer)?.[0]
  if (replies) return citeOwn(answer.slice(0, -replies.length), read, korean) + replies
  // stack-3 (c3a run, L1/L2/T2): the model put its one link on a line of its own under the answer ("네이버 날씨"), which read as a stray label.
  // A lone closing link under a sentence joins that sentence, as in "…1,385원이에요. [네이버 금융](…)"; under a table or a list it stays.
  // stack-4 (c4a run, L1/L4): the link still sat alone ("네이버") when its address was the results page's as given, with a space in it.
  const lone = /^([^]*\S)\s*\n\s*(\[[^\]\n]+\]\(https?:\/\/[^)\n]+\))\s*$/.exec(answer)
  if (lone && !/^\s*([|>#*+-]|\d+[.)]\s|```)/.test(lone[1]!.split('\n').at(-1)!)) return `${lone[1]} ${lone[2]}`
  if (!answer.trim() || !read.length || /https?:\/\//.test(answer)) return answer
  const url = sourcesOf(read)[0]!, link = `[${siteName(url, korean)}](${url.replace(/\)/g, '%29').replace(/ /g, '%20')})`
  const text = answer.trimEnd(), last = text.split('\n').at(-1)!
  // After a table, a list or a code block the link is a line of its own.
  return /^\s*([|>#*+-]|\d+[.)]\s|```)/.test(last) ? `${text}\n\n${link}` : `${text} ${link}`
}
// grokbar c4 C3/H5: three members had a results page in hand, were stopped at 15 s before writing, and the thread read "이번엔 못 찾았어요." three
// times. What a lookup member is given to read is kept as it reads: the rows of a search (title: what it says, date, address), the text under
// them (a weather or price box), a page that opened. A refusal, a wall or an empty search is not kept.
export function keepRead(tool: AgentTool, into: string[]): AgentTool {
  const note = (args: Record<string, unknown>, out: string): void => {
    try {
      if (tool.name === 'search_web') {
        if (!/^results for "[^\n]*" at https?:\/\/\S+ \(DATA/.test(out)) return
        const lines = out.split('\n').slice(1).filter(line => !line.startsWith('Results, each as '))
        into.push(lines.map(line => { const [title, url, ...rest] = line.startsWith('- ') ? line.slice(2).split(' — ') : []; return title && url && /^https?:\/\//.test(url) ? `${title}${rest.length ? `: ${rest.join(', ')}` : ''} ${url}` : line }).join('\n').trim())
      } else if (tool.name === 'open_page') { if (out.startsWith('page "') && typeof args['url'] === 'string') into.push(`${out}\n${args['url']}`) }
      else if (tool.name === 'read_pages') for (const page of (JSON.parse(out.replace(/^that did not work: /, '')) as { pages?: { url?: unknown; ready?: unknown; observation?: unknown }[] }).pages ?? []) if (page.ready === true && typeof page.url === 'string' && typeof page.observation === 'string') into.push(`${page.observation}\n${page.url}`)
    } catch { /* An output that is not a report was not read. */ }
  }
  if (!['search_web', 'open_page', 'read_pages'].includes(tool.name)) return tool
  return { ...tool, run: async (args, context) => { const out = await tool.run(args, context); note(args, out); return out }, ...(tool.runRich ? { runRich: async (args, context) => { const out = await tool.runRich!(args, context); note(args, out.text); return out } } : {}) }
}
// korean: the person's language, for the one line a cut-short result carries that the lead may show them.
export function settleMember(member: TeamMember, outcome: MemberOutcome, at: string, korean = false): void {
  const said = outcome.answer.trim()
  // A member that was stopped, failed or asked keeps nothing of what it read (GROKBOT rule 4); one whose time or calls ran out does.
  const read = outcome.error || outcome.asked ? '' : (outcome.read ?? '').trim()
  // Cut short on a line about what it was going to do, or on a draft that only says what it could not do while results are in hand: that is no answer.
  const answer = outcome.timedOut && (PROGRESS_ONLY.test(said) || !!read && WALLED.test(said)) ? '' : said
  member.finishedAt = at
  // A member with no answer and nothing read delivered nothing, time-boxed or not: it is failed, never done. A "Failed: " result is kept out of what the person sees.
  if (outcome.error || (!answer && !read)) { member.state = 'failed'; member.result = cut(`Failed: ${outcome.error ?? (outcome.timedOut ? 'it ran out of time before it reported anything.' : 'it ended without an answer.')}`, MEMBER_RESULT_CHARS); return }
  member.state = outcome.asked ? 'waiting' : 'done'
  const tail = outcome.budgetExhausted ? (korean ? '\n(처리 한도에서 멈춤)' : '\n(stopped at the token budget)') : outcome.timedOut ? (korean ? '\n(시간 한도에서 멈춤: 여기까지 찾은 내용)' : '\n(stopped at its time or call limit: this is what it had)') : ''
  // No answer of its own, or one cut short: its part is written from what it read, with those addresses (company-tools reportPrompt, mergedReport).
  // c4b r3: an answer cut short stood alone and the rows it had not got to were dropped with their addresses (one event of three in a
  // schedule). What it read stays under what it wrote, less the rows whose address the answer already names.
  const rest = !answer ? read : tail ? read.split('\n').filter(line => !(line.match(/https?:\/\/[^\s)\]>"'|]+/g) ?? []).some(url => answer.includes(url))).join('\n').trim() : ''
  if (rest) member.read = true
  member.result = cut([answer, rest].filter(Boolean).join('\n'), MEMBER_RESULT_CHARS - tail.length) + tail
  if (outcome.sources?.length) member.sources = sourcesOf(outcome.sources)
  const files = [...[...answer.matchAll(/\[([^\]]+)\]\(engram-artifact:[^)\s]+\)/g)].map(m => m[1]!), ...[...answer.matchAll(DOC_FILE)].map(m => m[1]!)]
  if (files.length) member.files = [...new Set(files)].slice(0, 10)
  else if (member.lookup && member.state === 'done' && !tail && answer && answeredLookup(answer, member.sources)) member.review = { ok: true, note: AUTO_REVIEW }
}

export const memberPersona = (member: TeamMember): string => `You are "${member.role}", a member of a hidden team working for one person through a lead. ${MEMBER_RULE}${member.lookup ? ` ${LOOKUP_RULE}` : ''}`

// The session wraps an answer cut short by the call or time limit for a person to read; a lead gets the answer itself.
export const cutShortAnswer = (answer: string): string => /^Not verified as complete\.\n\nThe tool-call or time limit was reached\.\n\nUnverified response:\n/.test(answer) ? answer.slice(answer.indexOf('Unverified response:\n') + 21).trim() : answer

const OPTIONAL = /가능하면|가능하다면|가능한 경우|여유가? ?되면|시간이? ?되면|if possible|if time permits|if you have time|optionally|nice to have|as a bonus/i
// An optional extra the person did not ask for is cut from a brief: one member chasing it held the whole team for 90 s (perf146).
export function withoutExtras(brief: string, personSaid: string): string {
  if (!OPTIONAL.test(brief) || OPTIONAL.test(personSaid)) return brief
  const kept = brief.split(/(?<=[.!?。\n,;])|(?=\()|(?<=\))/).filter(part => !OPTIONAL.test(part)).join('').replace(/[ \t]+\n/g, '\n').replace(/[,;]\s*$/, '').trim()
  return kept || brief
}

// Complete on its own, so a session trimmed while idle loses nothing.
export function memberTask(member: TeamMember, goal: string, redo?: MemberRedo, helpers: readonly TeamMember[] = []): string {
  return [
    'Your part:', member.brief,
    ...(member.deliverable ? ['', 'Deliver:', member.deliverable] : []),
    ...(redo ? ['', 'Your previous result:', member.result ?? '(none)', '', redo.answered ? 'The person answered your question:' : 'Your lead reviewed this and asks for a redo:', redo.note] : []),
    ...(helpers.length ? ['', 'Your helpers, not reviewed yet (a helper that asked gets the answer through review_member({id, ok:false, note:<the answer>}); review every helper before you report):', ...helpers.map(h => `- ${h.role} (${h.id}) [${h.state}]: ${(h.result ?? '').slice(0, 600)}`)] : []),
    '', 'The overall job (context only; do only your part):', goal.slice(0, 400),
  ].join('\n')
}

export function teamTree(team: TaskTeam | undefined): string {
  if (!team?.members.length) return 'No team on this task.'
  const lines: string[] = []
  const walk = (parentId: string | null) => {
    for (const m of team.members.filter(one => one.parentId === parentId)) {
      lines.push(`${'  '.repeat(m.depth - 1)}- ${m.role} (${m.id}) [${m.state}]${m.result ? ` — ${m.result.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`)
      walk(m.id)
    }
  }
  walk(null)
  return [...lines, `hires ${team.hires}/${team.maxHires}`].join('\n')
}

export function teamNote(team: TaskTeam | undefined): string {
  if (!team?.members.length) return ''
  const open = team.members.filter(m => m.parentId === null && ['done', 'failed', 'waiting'].includes(m.state))
  return ['The hidden team on this task:', teamTree(team), ...(team.members.some(m => m.state === 'failed') ? ['Members marked failed were lost; re-hire them with hire_members or finish with what exists.'] : []),
    ...open.map(m => m.state === 'waiting' ? `${m.role} (${m.id}) asked the person: ${m.result ?? ''}\nIf this message answers it, pass the answer with review_member({id:"${m.id}", ok:false, note:<the answer>}).` : `${m.role} (${m.id}) reported, not reviewed yet:\n${m.result ?? ''}`)].join('\n')
}

// Members that need the person are asked in the caller's thread at once, roles named; the caller's turn ends there.
const askUp = (members: readonly TeamMember[]): string | undefined => { const asking = members.filter(m => m.state === 'waiting'); return asking.length ? formatAsk(asking.map(m => `${m.role}: ${m.result ?? ''}`).join('\n'), []) : undefined }
const accepted = (m: TeamMember): boolean => m.state === 'done' && m.review?.ok === true && m.review.note === AUTO_REVIEW
const view = (m: TeamMember) => ({ id: m.id, role: m.role, state: accepted(m) ? 'released' : m.state, result: m.result ?? '', files: m.files ?? [], ...(m.sources?.length ? { sources: m.sources } : {}), ...(accepted(m) ? { accepted: true } : {}), ...(m.state === 'waiting' ? { ask: `${m.role}: ${m.result ?? ''}` } : {}) })
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max + 1) : ''

export function teamHireTools(host: TeamHost): AgentTool[] {
  // Members this caller hired in this turn and has not been handed back finished: an early return leaves some working.
  const open = new Map<string, Promise<void>>()
  // One early return per turn: words the turn does not take with the result (a check turn takes none) must not end every wait at once.
  let steerable = host.self === null && !!host.steered
  // c5 T1/R2: the merged answer never said how the work was split. The lead's hires of this turn, call by call: who took part, and who was
  // hired after the person spoke mid-work, is the host's to say; the lead puts it in a clause (MERGED_SHAPE).
  const took: string[] = [], late = new Set<string>()
  let spoke = false
  // Waits for the open members, or for the person's words to the lead, and hands back what there is.
  const collect = async (): Promise<string> => {
    const heard = new AbortController()
    const all = Promise.all([...new Set(open.values())])
    let steered = false
    try { steered = await Promise.race([all.then(() => false), steerable ? host.steered!(heard.signal).then(() => true) : new Promise<never>(() => undefined)]) } catch (error) { open.clear(); throw error } finally { heard.abort() }
    if (steered) { steerable = false; spoke = true }
    const team = (await host.load())?.team
    const mine = (team?.members ?? []).filter(m => open.has(m.id))
    const working = (m: TeamMember): boolean => steered && (host.live(m.id) || m.state === 'hired' || m.state === 'working')
    const ended = mine.filter(m => !working(m))
    for (const m of ended) open.delete(m.id)
    await host.release(ended.filter(accepted).map(m => m.id))
    const hiresLeft = team ? team.maxHires - team.hires : 0
    if (steered) return JSON.stringify({ members: mine.map(m => working(m) ? { id: m.id, role: m.role, state: 'working' } : view(m)), hiresLeft, note: STEER_NOTE })
    // Nothing delivered and someone needs the person: their question ends the turn. With results in hand the lead reports them and asks at the end.
    const partial = ended.some(m => m.state === 'waiting') && ended.some(m => m.state === 'done')
    const base = partial ? PARTIAL_NOTE : ended.every(accepted) ? ACCEPTED_NOTE : ended.some(accepted) ? `${ACCEPTED_NOTE} For the others: ${REVIEW_NOTE}` : REVIEW_NOTE
    const note = `${ended.some(m => m.sources?.length) ? `${base} ${SOURCES_NOTE}` : base}${partial ? '' : ` ${MERGED_SHAPE}`}`
    const added = (team?.members ?? []).filter(m => late.has(m.id))
    const split = host.self === null && took.length > 1 ? { split: `${took.length} took part, one part each${added.length ? `; ${added.length} of them joined after the person added to the job mid-work (${added.map(m => m.role).join(', ')})` : ''}` } : {}
    return (partial ? undefined : askUp(ended)) ?? JSON.stringify({ members: ended.map(view), hiresLeft, ...split, note })
  }
  const hire: AgentTool = {
    name: 'hire_members',
    description: `Hire 1 to ${HIRE_MAX_PER_CALL} hidden team members for separable parts of this job and wait for their results. Each gets role (short name), brief (its whole part, complete on its own, in at most 3 short lines: what to find or make, for where or when; only what the person asked for, no optional "if possible" extras) and deliverable (one line: what it hands back). lookup true for a part that only looks things up and reports (web research, a fact check, reading notes): it runs fast with reading tools in about ten seconds, and a sourced result comes back already accepted, with the pages it read in sources; leave it out for a part that makes or changes something. notes carries only what you already know that they need. Never hire for a one-step ask unless the person asked for bots or members. Returns each member's result, files and state; review with review_member each one that is not already accepted.`,
    argsSchema: {
      type: 'object', additionalProperties: false, required: ['members'],
      properties: {
        members: { type: 'array', maxItems: HIRE_MAX_PER_CALL, items: { type: 'object', additionalProperties: false, required: ['role', 'brief'], properties: { role: { type: 'string' }, brief: { type: 'string' }, deliverable: { type: 'string' }, lookup: { type: 'boolean' } } } },
        notes: { type: 'string' }, big: { type: 'boolean' },
      },
    },
    async run(args, context) {
      const asked = (Array.isArray(args['members']) ? args['members'] : []) as Record<string, unknown>[]
      // Nobody new: wait for the members an earlier call left working.
      if (!asked.length && open.size) return collect()
      const said = host.personSaid()
      const wanted = asked.map(m => ({ role: text(m?.['role'], 40), brief: withoutExtras(text(m?.['brief'], 1500), said), deliverable: withoutExtras(text(m?.['deliverable'], 300), said), lookup: m?.['lookup'] === true }))
      if (!wanted.length || wanted.length > HIRE_MAX_PER_CALL) throw new Error(`members needs 1 to ${HIRE_MAX_PER_CALL} entries, each with role, brief and deliverable.`)
      if (wanted.some(m => !m.role || m.role.length > 40 || !m.brief || m.brief.length > 1500 || m.deliverable.length > 300)) throw new Error('Each member needs role (1 to 40 characters), brief (1 to 1500) and deliverable (at most 300).')
      const notes = text(args['notes'], 1500).slice(0, 1500)
      if ((await host.tokensLeft()) < TEAM_TOKEN_RESERVE) return TOKEN_REFUSAL
      const n = wanted.length
      const out = await host.change((task): { refuse: string } | { ids: string[] } => {
        if (task.state !== 'running') return { refuse: 'No running task: nothing was hired.' }
        const team = task.team ?? newTeam()
        const parent = host.self === null ? undefined : team.members.find(m => m.id === host.self)
        if (host.self !== null && (!parent || parent.state === 'released')) return { refuse: 'You are no longer on this team: nothing was hired.' }
        const depth = (parent?.depth ?? 0) + 1
        if (depth > team.maxDepth) return { refuse: `Depth limit: a depth-${team.maxDepth} member cannot hire. Do this part yourself.` }
        const left = team.maxHires - team.hires
        if (n > left) return { refuse: `Hire budget: ${team.hires} of ${team.maxHires} used, ${left} left. Hire at most ${left} or do the work yourself.` }
        if (host.self === null && !team.approvedAt && (team.big || bigPlan(task.goal, wanted, args['big'] === true))) {
          task.team = team
          // Only a reply in a later turn than the one that was told to show the plan can approve it.
          if (team.planTurn !== undefined && task.turns > team.planTurn && TEAM_PLAN_YES.test(host.personSaid())) { team.approvedAt = new Date().toISOString(); logTask(task, 'Team plan approved') }
          else { team.big = true; team.planTurn = task.turns; return { refuse: PLAN_FIRST } }
        }
        task.team = team
        const at = new Date().toISOString()
        const ids = wanted.map(m => {
          const id = `m${team.members.length + 1}`
          team.members.push({ id, parentId: host.self, depth, role: m.role, brief: notes ? `${m.brief}\n\nNotes from ${parent?.role ?? 'the lead'}:\n${notes}` : m.brief, ...(m.deliverable ? { deliverable: m.deliverable } : {}), ...(m.lookup ? { lookup: true } : {}), state: 'hired', sessionKey: `team-${task.id}-${id}`, hiredAt: at })
          return id
        })
        team.hires += n
        logTask(task, `Hired ${wanted.map(m => m.role).join(', ')}`)
        return { ids }
      })
      if (!out) return 'No running task: nothing was hired.'
      if ('refuse' in out) return out.refuse
      took.push(...out.ids)
      if (spoke) for (const id of out.ids) late.add(id)
      const run = host.run(out.ids, context.signal)
      // An early return leaves this running with nobody awaiting it.
      run.catch(() => undefined)
      for (const id of out.ids) open.set(id, run)
      return collect()
    },
  }
  const review: AgentTool = {
    name: 'review_member',
    description: 'Record your review of a member you hired, after reading its result. ok true accepts it and releases the member. ok false with a note re-runs it once with that note (counts as a hire), or passes the person\'s answer to a member that asked a question.',
    argsSchema: { type: 'object', additionalProperties: false, required: ['id', 'ok', 'note'], properties: { id: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string' } } },
    async run(args, context) {
      const id = String(args['id'] ?? ''), ok = args['ok'] === true, note = text(args['note'], 1500).slice(0, 1500)
      if (!ok && !note) throw new Error('note says what to redo, or carries the person\'s answer.')
      const busy = host.live(id)
      const plan = await host.change((task): { refuse: string } | { act: 'accept' | 'spent' | 'redo' | 'answer'; role: string } => {
        const team = task.team, member = team?.members.find(m => m.id === id && m.parentId === host.self)
        if (!team || !member) return { refuse: `No member "${id}" hired by you.` }
        // Already accepted when it reported: a second accept is the same answer, not an error.
        if (ok && member.state === 'released' && member.review?.ok) return { act: 'accept', role: member.role }
        if (busy || !['done', 'failed', 'waiting'].includes(member.state)) return { refuse: `${member.role} is ${busy ? 'working' : member.state}; it can be reviewed once it has reported.` }
        if (ok) { member.review = { ok: true, note }; return { act: 'accept', role: member.role } }
        const answer = member.state === 'waiting'
        // grokbar B6 T1: re-running a lookup member that was cut at its time limit cost 10.7 s and brought the same page back.
        if ((!answer && (member.review?.ok === false || member.lookup)) || team.hires + 1 > team.maxHires) { member.review = { ok: false, note }; return { act: 'spent', role: member.role } }
        if (!answer) member.review = { ok: false, note }
        team.hires++; member.state = 'hired'; delete member.finishedAt
        return { act: answer ? 'answer' : 'redo', role: member.role }
      })
      if (!plan) return 'No running task.'
      if ('refuse' in plan) return plan.refuse
      const spent = `${plan.role} was already redone once, or is a lookup member (never re-run), or the hire/token budget is used. Released with its last result: use it and say in the answer what is missing.`
      if (plan.act === 'accept') { await host.release([id]); return JSON.stringify({ id, state: 'released' }) }
      if (plan.act === 'spent') { await host.release([id]); return spent }
      if ((await host.tokensLeft()) < TEAM_TOKEN_RESERVE) {
        await host.change(task => { const m = task.team?.members.find(one => one.id === id); if (m && task.team) { m.state = 'failed'; m.review ??= { ok: false, note }; task.team.hires-- } })
        await host.release([id]); return spent
      }
      await host.run([id], context.signal, { note, answered: plan.act === 'answer' })
      const after = (await host.load())?.team?.members.find(m => m.id === id)
      if (!after) return 'No running task.'
      if (after.state === 'waiting') return askUp([after])!
      if (plan.act === 'answer') return JSON.stringify(view(after))
      await host.release([id])
      return JSON.stringify({ ...view(after), state: 'released' })
    },
  }
  const status: AgentTool = {
    name: 'team_status',
    description: 'The hidden team on this task as a tree: each member, its state and the start of its result. Use it to answer "how is it going".',
    argsSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: async () => teamTree((await host.load())?.team),
  }
  return [hire, review, status]
}
