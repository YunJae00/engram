import type { AgentTool } from './agent-loop.js'
import { formatAsk, parseAsk } from './ask.js'
import { communityPost } from './search-template.js'
import { datedText, logTask, MEMBER_RESULT_CHARS, TEAM_MAX_DEPTH, TEAM_MAX_HIRES, type DelegatedTask, type MemberData, type TaskTeam, type TeamMember } from './delegated-tasks.js'

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
export const AUTO_REVIEW = 'auto: sourced lookup'
const ACCEPTED_NOTE = 'Members with accepted true are lookups, already accepted and released: do not call review_member for them, and write the answer now. One that stopped at its time limit handed back what it had read: answer its part from that. Report in one merged answer: several items go in one table, each row with the address it came from.'
export const MERGED_SHAPE = 'The merged answer reads like a colleague\'s message: one friendly lead sentence that already gives the gist and says only what the cells below show, then one table (item | what was found | source; when the person compares named points such as price and release date, one column per point instead, every cell a short value with its figure), and nothing after the table. A row\'s first cell is the name the person used ("아이폰 18"), never a variant\'s ("아이폰 18 프로"). Every concrete value a member reported stays in its row, labeled as the member labeled it (출시가, 예상, 전작, or the model it belongs to: "상위 모델 출시가 199만 원부터"), never dropped or turned into "미발표"; a thing already out has its 출시가 and date. No sentence about how the work was split, who took which part or how many took part: the first line is the answer. Never who is still working ("작업 중"), a member id or a role label ("대구날씨"). No other sentence about bots, members or collecting results, no closing question or offer, and no word about time, limits, attempts or what failed. A value marked "(no live source)" lost the page it was read on: its cell keeps the value labeled unconfirmed ("199만 원(미확인)"), and its source cell links another page that member read, or, with none, says 미확인; never an empty cell. A member that found nothing keeps its row, with a plain "못 찾았어요" in the person\'s language; a value not out yet keeps the labeled figure its member reported ("예상 130만 원대").'
const SOURCES_NOTE = 'sources lists the pages each member actually read. In the merged table the last cell of every row is that member\'s source as a markdown link, [site name](address), with the address copied exactly from sources and the link text the site\'s or publication\'s own name (네이버 날씨, Apple, 삼성전자 뉴스룸, 연합뉴스), a post on a platform is named by the platform (네이버 블로그, 네이버 카페, 유튜브, 티스토리), never by the writer\'s id, a site you cannot name by its host as written in the address (store.google.com), never a piece of a title, never a member\'s role or name; never a site name alone. A row names a member only when the person named the members themselves ("지민, 서연한테 나눠서"): then its first cell is the item with that name in parentheses.'
const STEER_NOTE = 'The person wrote to you while the team worked; their words follow this result. Members with state working keep going. If their words add or change a part, call hire_members now for that part only; when they drop or replace a part, give that member id in stop (the new part, if any, in members): it ends and is no part of the answer. With nothing to add or drop, call hire_members with members [] to wait. Either call also returns the members still working. Then give one answer that covers everything.'
const REVIEW_NOTE = 'Review each member with review_member before you report, all in one step. A member that stopped at its time limit handed back what it had: accept it and say what is missing; a lookup member is never re-run. A failed member delivered nothing: say that part is missing, or redo it once if the person asked for it. A member that needs the person is asked in your thread for you; when they answer, pass the answer with review_member({id, ok:false, note:<answer>}).'

export const LOOKUP_TOOLS = new Set(['search_web', 'read_pages', 'open_page', 'read_open_page', 'look', 'reveal', 'search_memory', 'read_note', 'search_chats', 'ask_person'])
export const TEAM_ANSWER_MS = 28_000
export const LATE_CEILING_MS = 90_000
export const LOOKUP_MAX_CALLS = 4
export const LOOKUP_CALL_MS = 5_500
export const LOOKUP_ROUND_MS = 9_000
export const ANSWER_FROM_THIS = 'No further tool call will run. Answer now from what you have, in the person\'s language.'
export function timeBoxed(tool: AgentTool, left: () => number): AgentTool {
  if (tool.name === 'ask_person') return tool
  const closing = (out: string): string => left() < LOOKUP_ROUND_MS ? `${out}\n\n${ANSWER_FROM_THIS}` : out
  return { ...tool, run: async (args, context) => left() < LOOKUP_CALL_MS ? ANSWER_FROM_THIS : closing(await tool.run(args, context)), ...(tool.runRich ? { runRich: async (args, context) => { if (left() < LOOKUP_CALL_MS) return { text: ANSWER_FROM_THIS }; const out = await tool.runRich!(args, context); return { ...out, text: closing(out.text) } } } : {}) }
}
export const LOOKUP_RULE = 'You only look things up: you have reading tools and about ten seconds, enough for one search and, when that does not hold the answer, one more search or one page. Search first with the query in the person\'s language (when the results of a first search come with your part, that search is done: start from them): the results come as a list, each with its title, its own address, what it says and its date. When they hold what the brief asks, report at once from them, each fact with the address of the result it came from (the maker\'s own page or a news article when the list has one, before a café or blog post); open a page only for a number none of them shows. When the first results do not hold what the brief asks (no figure, no date, nothing about that product or company), search once more in other words before you report - the maker\'s or the product\'s English name ("Galaxy S27 price", "Linear changelog"), or a news search (kind "news") - and never a third time. A source is named by its site or publication (삼성전자 뉴스룸, 연합뉴스); a post on a platform is named by the platform (네이버 블로그, 네이버 카페, 유튜브, 티스토리), never by the writer\'s id; a site whose name you do not know is named by its host as written in the address (store.google.com): never a piece of the page\'s title. When the brief names what to find about a thing (its price, its release date), report each on a line of its own, "가격: …", "출시일: …", each a short value with a figure in it, a price with its currency: an answer whose price has no digit is not finished. Every value says what it is and whose it is: a thing already out has its 출시가 and its date, never "미발표"; a value not out yet is the reported expectation, labeled 예상 ("예상 130만 원대", "2027년 2월 예상"); a value of anything other than exactly the name in your part (another model or edition of it, the one before it) names what it belongs to ("상위 모델 출시가 199만 원부터", "전작 출시가 115만 원"). When the named thing has no figure yet, give the closest real one, labeled that way, with what is known of the named thing itself; when the results hold none, your one more search is for the previous model\'s launch price (its name and "출고가"). A date is written as the results give it (11월 10일). Report in the person\'s language, in plain polite sentences (in Korean the -요 form): the facts first, each with its address (the page itself, never a search-results address, unless the fact was read on the results page itself). A figure read from the results page\'s own box (weather, a stock quote, a rate, a score) is cited to that service by name with the results page\'s address, the one after "results for … at" - [네이버 날씨](that address), [네이버 증권](that address) - never to a blog or any other result you did not take it from. A number comes from a result or is a previous model\'s known launch price, labeled as what it is: never a number of your own, and never a line with no number in it ("전작보다 인상 예상" alone is not a price); never write about time, limits, attempts, tools, pages that did not open or what you failed to do. A page that wants a sign-in or a robot check is left alone, never worked around: read another source. If your part needs anything other than reading, say so in one line and stop.'

export function skipWalls(tool: AgentTool): AgentTool {
  if (tool.name === 'ask_person') return tool
  const skip = (text: string, args: Record<string, unknown>): string => parseAsk(text)
    ? `${typeof args['url'] === 'string' ? args['url'] : 'That source'} needs the person (a sign-in, a robot check, or a setting only they have) and was not read. Do not ask about it and do not try to get past it: read another source (open_page on a site that holds the answer). If nothing else has it, report what you have and name this as the missing part.`
    : text
  return { ...tool, run: async (args, context) => skip(await tool.run(args, context), args), ...(tool.runRich ? { runRich: async (args, context) => { const out = await tool.runRich!(args, context); return { ...out, text: skip(out.text, args) } } } : {}) }
}

export interface MemberOutcome { answer: string; asked?: boolean; budgetExhausted?: boolean; timedOut?: boolean; error?: string; sources?: string[]; read?: string; report?: MemberData | null }
export interface MemberRedo { note: string; answered?: boolean }

export interface TeamHost {
  self: string | null
  load(): Promise<DelegatedTask | undefined>
  steered?(signal: AbortSignal): Promise<void>
  change<T>(work: (task: DelegatedTask) => T): Promise<T | undefined>
  run(ids: string[], signal?: AbortSignal, redo?: MemberRedo): Promise<void>
  release(ids: string[]): Promise<void>
  live(id: string): boolean
  tokensLeft(): Promise<number>
  alive?(url: string, signal: AbortSignal): Promise<boolean>
  due?(): Promise<number | undefined>
  personSaid(): string
}

const newTeam = (): TaskTeam => ({ members: [], hires: 0, maxHires: TEAM_MAX_HIRES, maxDepth: TEAM_MAX_DEPTH, big: false })
const cut = (text: string, max: number) => text.length > max ? text.slice(0, max) : text
const DOC_FILE = /(?:^|[\s("'`])((?:[~.]?\/|[A-Za-z]:\\)?[^\s"'`()<>]+\.(?:pdf|docx?|xlsx?|pptx?|csv|md|txt|html?|json|png|jpe?g|zip))(?=$|[\s)"'`.,])/gi

export function bigPlan(goal: string, members: readonly { role: string; brief: string }[], flagged: boolean): boolean {
  return flagged || members.length > 3 || CODING.test([goal, ...members.flatMap(m => [m.role, m.brief])].join('\n'))
}

export const unreviewed = (team: TaskTeam | undefined, parentId: string | null): TeamMember[] => (team?.members ?? []).filter(m => m.parentId === parentId && m.state !== 'released')
export const teamUnverified = (task: DelegatedTask): boolean => (task.team?.members.length ?? 0) > 0 && task.verified !== true
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

const PROGRESS_ONLY = /^(?:[^\n]{0,120}(?:겠습니다|겠어요|[할볼릴]게요|하는 중(?:입니다|이에요)?)|(?:I['’]ll|I will|I am going to|I'm going to|Let me|Searching|Looking|Checking)\b[^\n]{0,120})[.!…\s]*$/i
const SEARCH_PAGE = /^https?:\/\/(?:[^/\s]*\bsearch\.|[^\s?#]*\/(?:search|results)\b|\S*[?&](?:q|query|search_query|search|wd|keyword)=)/i
const WALLED = /로봇|캡차|자동\s?입력|비정상적인 (?:트래픽|접근)|접근이?\s?(?:거부|차단|제한)|차단(?:되|됐|당)|오류(?:가|를)?\s?(?:발생|났|나서)|에러|페이지를 찾을 수 없|열리지 않|(?:열|읽|찾|확인할|가져올|접속할) 수 ?(?:가 )?없|(?:읽|찾|확인하|가져오|접속하)지 못|실패|\b(?:robot|captcha|unusual traffic|access denied|forbidden|blocked|not found|error|failed|could ?n[o']t|cannot|can't|unable to|timed out)\b/i
export function answeredLookup(answer: string, read: readonly string[] = []): boolean {
  const links = answer.match(/https?:\/\/[^\s)\]>"']+/g) ?? []
  if (!links.some(link => !SEARCH_PAGE.test(link)) && !read.length || WALLED.test(answer)) return false
  const said = answer.replace(/https?:\/\/[^\s)\]>"']+/g, ' ').split(/(?<=[.!?…。])\s+|\n+/).filter(part => part.trim() && !PROGRESS_ONLY.test(part.trim())).join(' ').replace(/[\s\p{P}\p{S}]+/gu, '')
  return said.length >= 30 || /\d/.test(said) && said.length >= 4
}
const SOURCES_MAX = 3
const cutTitle = (words: string, url: string): boolean => { const [title, found] = TITLES.get(url) ?? TITLES.get(plainAddress(url)) ?? [], name = words.trim(); return !!title && name.length >= 2 && title.includes(name) && sitePart(title, found) !== name }
const TITLES = new Map<string, [title: string, found: string]>()
export const keepTitle = (url: string, title: string, found = ''): void => { TITLES.delete(url); TITLES.set(url, [title, found]); if (TITLES.size > 400) TITLES.delete(TITLES.keys().next().value!) }
const NAME_MAX = 12
const nameLike = (words: string): boolean => { const name = words.trim(); return name.length >= 2 && [...name].length <= NAME_MAX && !/\d|…|\.{2,}/.test(name) && !PLACE.test(name) && !HOSTISH.test(name) }
const sitePart = (title: string, found = ''): string => {
  const parts = title.split(/\s[-|–—:]{1,2}\s/).map(part => part.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean), site = parts.at(-1) ?? ''
  const searched = found.toLowerCase().split(/\s+/).filter(word => word.length >= 2)
  return parts.length > 1 && nameLike(site) && !searched.some(word => site.toLowerCase().includes(word)) ? site : ''
}
export function keepSources(tool: AgentTool, seen: Set<string>): AgentTool {
  const note = (args: Record<string, unknown>, out: string): void => {
    try {
      if (tool.name === 'search_web') { const at = /^results for "[^\n]*" at (https?:\/\/\S+) \(DATA/.exec(out)?.[1]; if (at) { seen.add(at); for (const [, title, url] of out.matchAll(/^- (.+?) — (https?:\/\/\S+)/gm)) keepTitle(url!, title!, /^results for "([^\n]*)" at /.exec(out)?.[1] ?? '') } }
      else if (tool.name === 'open_page') { if (out.startsWith('page "') && typeof args['url'] === 'string' && /^https?:\/\//i.test(args['url'])) seen.add(args['url']) }
      else if (tool.name === 'read_pages') for (const page of (JSON.parse(out.replace(/^that did not work: /, '')) as { pages?: { url?: unknown; ready?: unknown }[] }).pages ?? []) if (page.ready === true && typeof page.url === 'string') seen.add(page.url)
    } catch { }
  }
  if (!['search_web', 'open_page', 'read_pages'].includes(tool.name)) return tool
  return { ...tool, run: async (args, context) => { const out = await tool.run(args, context); note(args, out); return out }, ...(tool.runRich ? { runRich: async (args, context) => { const out = await tool.runRich!(args, context); note(args, out.text); return out } } : {}) }
}
const sourcesOf = (read: readonly string[]): string[] => [...new Set(read)].sort((a, b) => Number(SEARCH_PAGE.test(a)) - Number(SEARCH_PAGE.test(b))).slice(0, SOURCES_MAX)

const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/
export function citeMembers(answer: string, members: readonly TeamMember[], korean = false): string {
  if (!answer.trim()) return answer
  const cited = members.filter(m => m.sources?.length && m.state !== 'failed')
  const escaped = (url: string): string => url.replace(/\)/g, '%29').replace(/ /g, '%20')
  const href = (m: TeamMember): string => escaped(m.sources![0]!)
  const name = (m: TeamMember): string => m.botId ? m.role.replace(/[[\]|]/g, '').trim() : ''
  const lines = answer.split('\n')
  const named = (m: TeamMember): string[] => (m.result?.match(/https?:\/\/[^\s)\]>"'|]+/g) ?? []).map(url => url.replace(/[.,;:!?]+$/, ''))
  let sourceColumn = false
  const used = new Set<string>()
  for (const [i, line] of lines.entries()) {
    if (!/^\s*\|.*\|\s*$/.test(line) || TABLE_RULE.test(line)) continue
    const cells = line.trim().slice(1, -1).split('|').map(cell => cell.trim())
    if (TABLE_RULE.test(lines[i + 1] ?? '')) { sourceColumn = /출처|링크|source|link/i.test(cells.at(-1)!); continue }
    const words = cells[0]!.replace(/[*_`]/g, '').split(/[\s(),/·]+/).filter(word => word.length >= 2)
    const scored = members.map(m => ({ m, hits: words.filter(word => `${m.role} ${m.brief}`.includes(word)).length })).filter(one => one.hits).sort((x, y) => y.hits - x.hits)
    if (!scored.length || scored[1]?.hits === scored[0]!.hits) continue
    const own = scored[0]!.m
    if (name(own) && !line.includes(name(own))) cells[0] = `${cells[0]}(${name(own)})`
    if (!/https?:\/\//.test(line)) {
      const last = cells.at(-1)!.replace(/[[\]]/g, ''), label = sourceColumn || cells.length === 1
      const vague = label && (PLACE.test(last.trim()) || /^(?:블로그 글|커뮤니티 글|blog post|forum post)$/i.test(last.trim())), post = vague ? [...linked(own.result ?? '')].find(([url]) => communityPost(url)) : undefined
      const bare = vague && !post ? (own.result?.match(/https?:\/\/[^\s)\]>"'|]+/g) ?? []).map(url => url.replace(/[.,;:!?]+$/, '')).find(url => communityPost(url)) : undefined
      const first = cited.includes(own) ? own.sources![0]! : undefined
      const held = !post && !bare && (!first || SEARCH_PAGE.test(first) && !boxed(first)) ? figureSources(own.result ?? '', cells.slice(1)) : []
      const words = (url: string, swapped = false): string => vague || !nameLike(last) || hostPiece(last, url) || cutTitle(last, url) || /(?:카페|블로그|포스트)$/.test(last.trim()) && communityPost(url) || swapped && /검색|search/i.test(last) ? '' : last.replace(/^[-–—\s]*$/, '')
      const cite = (urls: readonly string[], lone?: string): string => { const names = urls.map(url => urls.length === 1 && lone || sourceName(url, korean)), same = new Set(names).size < names.length; return urls.map((url, at) => `[${same ? `${names[at]} ${at + 1}` : names[at]}](${escaped(url)})`).join(' · ') }
      const page = named(own).find(url => !SEARCH_PAGE.test(url))
      if (post) cells[cells.length - 1] = `[${post[1]}](${post[0]})`
      else if (bare) cells[cells.length - 1] = `[${sourceName(bare, korean)}](${bare})`
      else if (held.length) cells[cells.length - 1] = label ? cite(held, words(held[0]!, true)) : `${cells.at(-1)} ${cite(held)}`
      else if (page && (!first || SEARCH_PAGE.test(first) && !boxed(first))) cells[cells.length - 1] = label ? cite([page], words(page, true)) : `${cells.at(-1)} ${cite([page])}`
      else if (cited.includes(own)) cells[cells.length - 1] = label ? `[${words(own.sources![0]!) || sourceName(own.sources![0]!, korean)}](${href(own)})` : `${cells.at(-1)} [${sourceName(own.sources![0]!, korean)}](${href(own)})`
      else if (vague) cells[cells.length - 1] = postWord(!/카페|caf/i.test(last), korean)
    } else {
      const own1 = /\[[^\]\n]*\]\((https?:\/\/[^)\s]+)\)\s*$/.exec(cells.at(-1)!), held = own1 && SEARCH_PAGE.test(own1[1]!) && !boxed(own1[1]!) ? figureSources(own.result ?? '', cells.slice(1, -1)) : []
      if (held.length) cells[cells.length - 1] = held.map(url => `[${sourceName(url, korean)}](${escaped(url)})`).join(' · ')
    }
    if (sourceColumn) cells[cells.length - 1] = rowSource(cells, own, used, korean)
    lines[i] = `| ${cells.join(' | ')} |`
  }
  const fixed = placeNamed(lines.join('\n'), members, korean, true)
  const missing = cited.filter(m => !m.sources!.some(url => fixed.includes(url)) && !fixed.includes(href(m)) && !named(m).some(url => fixed.includes(url)))
  const rows = fixed.split('\n').filter(line => /^\s*\|.*\|\s*$/.test(line) && !TABLE_RULE.test(line)).slice(1)
  if (rows.length && rows.every(row => /\]\(https?:\/\//.test(row))) return fixed.replace(/\n+[ \t]*(?:\*\*)?(?:출처|Sources?)(?:\*\*)?[ \t]*[:：][^\n]*\s*$/i, '')
  if (!missing.length) return fixed
  return `${fixed.trimEnd()}\n\n${korean ? '출처' : 'Sources'}: ${[...new Map(missing.map(m => [href(m), `[${sourceName(m.sources![0]!, korean)}](${href(m)})`])).values()].join(' · ')}`
}
const SECONDARY = /youtube\.com|youtu\.be|tv\.naver\.com|\/shorts\b|smartstore\.|shopping\.naver|coupang\.com|11st\.co\.kr|gmarket\.co\.kr|auction\.co\.kr|danawa\.com/i
const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^(www|m)\./, '') } catch { return url } }
function rowSource(cells: readonly string[], own: TeamMember, used: Set<string>, korean: boolean): string {
  let cell = cells.at(-1)!, links = [...cell.matchAll(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g)]
  if (links.length > 1) {
    const real = links.filter(link => (!SEARCH_PAGE.test(link[2]!) || boxed(link[2]!)))
    if (real.length) { for (const link of real) used.add(hostOf(link[2]!)); return real.length === links.length ? cell : real.map(link => link[0]).join(' · ') }
    links = links.slice(0, 1); cell = links[0]![0]
  }
  const now = links[0]?.[2], cited = [...new Set([...(own.result?.match(/https?:\/\/[^\s)\]>"'|]+/g) ?? []).map(url => url.replace(/[.,;:!?]+$/, '')), ...(own.sources ?? [])])].filter(url => !SEARCH_PAGE.test(url))
  const holds = new Set(figureSources(own.result ?? '', cells.slice(1, -1)))
  const rank = (url: string): number => (holds.has(url) ? 0 : 8) + (communityPost(url) || SECONDARY.test(url) ? 4 : 0) + (used.has(hostOf(url)) ? 2 : 0)
  const order = cited.map((url, at) => ({ url, at })).sort((a, b) => rank(a.url) - rank(b.url) || a.at - b.at).map(one => one.url), best = order[0]
  const name = (url: string): string => `[${linked(own.result ?? '').get(url) ?? sourceName(url, korean)}](${url.replace(/\)/g, '%29').replace(/ /g, '%20')})`
  const replace = !now || SEARCH_PAGE.test(now) && !boxed(now) || cited.includes(now)
  const each = order.filter(url => holds.has(url))
  if (replace && each.length > 1) { for (const url of each) used.add(hostOf(url)); return each.map(name).join(' · ') }
  const url = best && (!now || SEARCH_PAGE.test(now) && !boxed(now) || cited.includes(now) && rank(best) < rank(now)) ? best : now
  if (!url) return cell
  used.add(hostOf(url))
  if (url === now) return /^\s*\[(?:출처|source)\]/i.test(cell) ? cell.replace(/\[(?:출처|source)\]/i, `[${sourceName(now, korean)}]`) : cell
  return name(url)
}
const boxed = (url: string): boolean => { try { return BOXES.some(([words]) => words.test(new URL(url).searchParams.get('query') ?? '')) } catch { return false } }
const VIDEO = /youtube\.com|youtu\.be|\/shorts\b|tv\.naver\.com/i
function figureSources(result: string, cells: readonly string[]): string[] {
  const squeeze = (words: string): string => words.replace(/\s+/g, '')
  const figures = [...new Set((squeeze(cells.join(' ').replace(ADDRESS, '')).match(/20\d\d년\d{1,2}월(?:\d{1,2}일)?|\d{1,2}월\d{1,2}일|\d[\d,.]{2,}/g) ?? []).filter(figure => !/^20\d\d$/.test(figure)))]
  const pages = result.split('\n').flatMap(line => { const url = (line.match(ADDRESS) ?? []).map(one => one.replace(/[.,;:!?]+$/, '')).find(one => !SEARCH_PAGE.test(one)), said = squeeze(line.replace(ADDRESS, '')); return url ? [{ url, holds: figures.filter(figure => said.includes(figure)) }] : [] })
  const open = new Set(figures), chosen: string[] = []
  for (const video of [false, true]) for (;;) {
    const best = pages.filter(page => VIDEO.test(page.url) === video).map(page => ({ page, gain: page.holds.filter(figure => open.has(figure)).length })).sort((a, b) => b.gain - a.gain)[0]
    if (!best?.gain) break
    chosen.push(best.page.url); for (const figure of best.page.holds) open.delete(figure)
  }
  return [...new Set(chosen)].slice(0, SOURCES_MAX)
}
const HOSTISH = /^(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}\/?$/i
const PLACE = /^(?:(?:네이버|다음|naver|daum)\s?)?(?:블로그|카페|포스트|blog|caf[eé]|post)(?:\s+[\w.-]+)?$|^(?:티스토리|브런치|tistory|brunch)$/i
const postWord = (blog: boolean, korean: boolean): string => korean ? (blog ? '블로그 글' : '커뮤니티 글') : blog ? 'blog post' : 'forum post'
const linked = (text: string): Map<string, string> => new Map([...text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)].filter(([, title, url]) => nameLike(title!) && !hostPiece(title!, url!)).map(([, title, url]) => [url!, title!.replace(/\|/g, ' ').trim()]))
const hostPiece = (words: string, url: string): boolean => { try { const name = words.trim().toLowerCase(); return /^[\w.-]+$/.test(name) && new URL(url).hostname.toLowerCase().includes(name) } catch { return false } }
export const givenName = (words: string, url: string): boolean => nameLike(words) && !hostPiece(words, url)
export function placeNamed(text: string, members: readonly TeamMember[], korean = false, hosts = false): string {
  const titles = new Map(members.flatMap(m => [...linked(m.result ?? '')]))
  const unnamed = (words: string, url: string): boolean => PLACE.test(words.trim()) || hosts && (HOSTISH.test(words.trim()) || /…|\.{3,}/.test(words) || hostPiece(words, url) || cutTitle(words, url))
  return text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (whole, words: string, url: string) => unnamed(words, url) ? `[${titles.get(url) ?? sourceName(url, korean)}](${url})` : whole)
}
export function sourceName(url: string, korean = false): string {
  const plain = siteName(url, korean)
  let host: string
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { return korean ? '출처' : 'source' }
  const platform = SEARCH_PAGE.test(url) ? undefined : PLATFORMS.find(([hosts]) => hosts.test(host))
  if (platform) return platform[korean ? 1 : 2]
  if (plain !== host && !(communityPost(url) && !SEARCH_PAGE.test(url))) return plain
  const declared = DECLARED.get(host.replace(/^m\./, ''))
  if (declared) return declared
  const [title, found] = TITLES.get(url) ?? TITLES.get(plainAddress(url)) ?? []
  return title && sitePart(title, found) || host
}
export function siteOf(url: string, given: unknown, korean = true): string {
  const known = sourceName(url, korean)
  let host = ''
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { }
  return known === host && typeof given === 'string' && givenName(given, url) && !/^(?:출처|source|링크|link)$/i.test(given.trim()) ? given.trim() : known
}
const DECLARED = new Map<string, string>()
export function keepDeclaredName(url: string, head: string): void {
  let host: string
  try { host = new URL(url).hostname.replace(/^(www|m)\./, '') } catch { return }
  const meta = (key: string): string | undefined => [...head.matchAll(/<meta\b[^>]*>/gi)].map(tag => tag[0]).filter(tag => new RegExp(`(?:property|name)\\s*=\\s*["']${key}["']`, 'i').test(tag)).map(tag => /content\s*=\s*(["'])([^"']*)\1/i.exec(tag)?.[2]).find(Boolean)
  const name = (meta('og:site_name') ?? meta('application-name') ?? '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
  if (!name || !nameLike(name) || /\uFFFD|^(?:home|홈|index|untitled)$/i.test(name)) return
  DECLARED.delete(host); DECLARED.set(host, name); if (DECLARED.size > 400) DECLARED.delete(DECLARED.keys().next().value!)
}
export async function pageHead(body: ReadableStream<Uint8Array> | null, max = 65_536): Promise<string> {
  if (!body) return ''
  const reader = body.getReader(), decoder = new TextDecoder()
  let text = ''
  try {
    for (let bytes = 0; bytes < max && !/<\/head>/i.test(text);) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; text += decoder.decode(value, { stream: true }) }
  } finally { void reader.cancel().catch(() => undefined) }
  return text
}
const declaredNamed = (text: string, korean: boolean): string => text.replace(/\[(출처|source)\]\((https?:\/\/[^)\s]+)\)/gi, (_whole, _word: string, url: string) => `[${sourceName(url, korean)}](${url})`)
const PLATFORMS: [RegExp, string, string][] = [[/^(m\.)?cafe\.naver\.com$/, '네이버 카페', 'Naver Cafe'], [/^(m\.)?blog\.naver\.com$/, '네이버 블로그', 'Naver Blog'], [/^(m\.)?post\.naver\.com$/, '네이버 포스트', 'Naver Post'],
  [/^(m\.)?smartstore\.naver\.com$/, '스마트스토어', 'Smart Store'], [/(^|\.)tistory\.com$/, '티스토리', 'Tistory'], [/(^|\.)brunch\.co\.kr$/, '브런치', 'Brunch'], [/^(m\.)?cafe\.daum\.net$/, '다음 카페', 'Daum Cafe'], [/(^|\.)velog\.io$/, '벨로그', 'velog']]
export const isSearchPage = (url: string): boolean => SEARCH_PAGE.test(url)
const SITES: [RegExp, string, string][] = [[/(^|\.)naver\.com$/, '네이버', 'Naver'], [/(^|\.)daum\.net$/, '다음', 'Daum'], [/(^|\.)google\.[a-z.]+$/, '구글', 'Google'], [/(^|\.)bing\.com$/, 'Bing', 'Bing'],
  [/(^|\.)apple\.com$/, 'Apple', 'Apple'], [/(^|\.)samsung\.(com|co\.kr)$/, '삼성전자', 'Samsung'], [/(^|\.)(youtube\.com|youtu\.be)$/, '유튜브', 'YouTube'], [/(^|\.)slack\.com$/, '슬랙', 'Slack'], [/(^|\.)notion\.(so|com)$/, '노션', 'Notion'], [/(^|\.)linear\.app$/, '리니어', 'Linear'], [/(^|\.)(weather|kma)\.go\.kr$/, '기상청', 'KMA'], [/(^|\.)coex\.co\.kr$/, '코엑스', 'COEX'],
  [/(^|\.)mt\.co\.kr$/, '머니투데이', 'Money Today'], [/(^|\.)asiae\.co\.kr$/, '아시아경제', 'Asia Economy'], [/(^|\.)hankyung\.com$/, '한국경제', 'Hankyung'], [/(^|\.)mk\.co\.kr$/, '매일경제', 'Maeil Business'], [/(^|\.)biz\.chosun\.com$/, '조선비즈', 'ChosunBiz'], [/(^|\.)chosun\.com$/, '조선일보', 'Chosun Ilbo'], [/(^|\.)joongang\.co\.kr$/, '중앙일보', 'JoongAng'], [/(^|\.)donga\.com$/, '동아일보', 'Dong-A'], [/(^|\.)yna\.co\.kr$/, '연합뉴스', 'Yonhap'], [/(^|\.)etnews\.com$/, '전자신문', 'etnews'], [/(^|\.)zdnet\.co\.kr$/, '지디넷코리아', 'ZDNet Korea'], [/(^|\.)edaily\.co\.kr$/, '이데일리', 'Edaily'], [/(^|\.)sedaily\.com$/, '서울경제', 'Seoul Economic Daily'], [/(^|\.)hani\.co\.kr$/, '한겨레', 'Hankyoreh'], [/(^|\.)khan\.co\.kr$/, '경향신문', 'Kyunghyang'], [/(^|\.)newsis\.com$/, '뉴시스', 'Newsis'], [/(^|\.)news1\.kr$/, '뉴스1', 'News1'], [/(^|\.)heraldcorp\.com$/, '헤럴드경제', 'Herald'], [/(^|\.)fnnews\.com$/, '파이낸셜뉴스', 'Financial News'], [/(^|\.)dt\.co\.kr$/, '디지털타임스', 'Digital Times'], [/(^|\.)inews24\.com$/, '아이뉴스24', 'iNews24'], [/(^|\.)ddaily\.co\.kr$/, '디지털데일리', 'Digital Daily'], [/(^|\.)bloter\.net$/, '블로터', 'Bloter'], [/(^|\.)platum\.kr$/, '플래텀', 'Platum'], [/(^|\.)venturesquare\.net$/, '벤처스퀘어', 'Venture Square'], [/(^|\.)startuprecipe\.co\.kr$/, '스타트업레시피', 'Startup Recipe'], [/(^|\.)thevc\.kr$/, '더브이씨', 'THE VC'], [/(^|\.)wikipedia\.org$/, '위키백과', 'Wikipedia'], [/(^|\.)namu\.wiki$/, '나무위키', 'Namuwiki'], [/(^|\.)kbs\.co\.kr$/, 'KBS', 'KBS'], [/(^|\.)imbc\.com$/, 'MBC', 'MBC'], [/(^|\.)sbs\.co\.kr$/, 'SBS', 'SBS'], [/(^|\.)ytn\.co\.kr$/, 'YTN', 'YTN'], [/(^|\.)jtbc\.co\.kr$/, 'JTBC', 'JTBC']]
export function siteName(url: string, korean = false): string {
  let host: string
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { return url }
  if (communityPost(url) && !SEARCH_PAGE.test(url)) return postWord(/blog|post\.|tistory|brunch|velog|medium/.test(host), korean)
  const known = SITES.find(([hosts]) => hosts.test(host))
  if (!known) return host
  if (!SEARCH_PAGE.test(url)) return known[korean ? 1 : 2]
  let asked = ''
  try { asked = known[2] === 'Naver' ? new URL(url).searchParams.get('query') ?? '' : '' } catch { }
  const box = BOXES.find(([words]) => words.test(asked))
  return `${known[korean ? 1 : 2]} ${box ? box[korean ? 1 : 2] : korean ? '검색' : 'search'}`
}
const BOXES: [RegExp, string, string][] = [[/날씨|기온|강수|미세\s?먼지|weather|forecast/i, '날씨', 'Weather'], [/주가|주식|시세|증시|stock|share price/i, '증권', 'Finance'], [/환율|exchange rate/i, '금융', 'Finance']]
export const LINK_CHECK_MS = 1_500
export const linkAnswers = (status: number): boolean => status >= 200 && status < 400
export const localAddress = (url: string): boolean => { try { const host = new URL(url).hostname.toLowerCase(); return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.startsWith('[') || /^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) || !host.includes('.') } catch { return true } }
const ADDRESS = /https?:\/\/[^\s)\]>"'|]+/g
const plainAddress = (url: string): string => { try { return decodeURI(url) } catch { return url } }
const unloaded = (text: string, read: readonly string[]): string[] => { const loaded = new Set(read.map(plainAddress)); return [...new Set((text.match(ADDRESS) ?? []).map(url => url.replace(/[.,;:!?]+$/, '')))].filter(url => !loaded.has(plainAddress(url))) }
export async function deadOf(shown: readonly string[], alive: (url: string, signal: AbortSignal) => Promise<boolean>, ms: number): Promise<string[]> {
  if (!shown.length) return []
  const limit = new AbortController(), timer = setTimeout(() => limit.abort(), ms)
  const late = new Promise<boolean>(resolve => limit.signal.addEventListener('abort', () => resolve(true), { once: true }))
  const dead = (await Promise.all(shown.map(async url => (await Promise.race([Promise.resolve().then(() => alive(url, limit.signal)).catch(() => limit.signal.aborted), late])) ? '' : url))).filter(Boolean)
  clearTimeout(timer)
  limit.abort()
  return dead
}
const TABLE_ROW = /^\s*\|.*\|\s*$/
const tidyCell = (line: string): string => line.replace(/\|[ \t]*(?:·[ \t]*)+/g, '| ').replace(/(?:[ \t]*·)+[ \t]*\|/g, ' |').replace(/·[ \t]*(?:·[ \t]*)+/g, '· ')
function withoutDead(answer: string, dead: readonly string[], read: readonly string[], korean: boolean, named = true): string {
  const own = sourcesOf(read)[0], literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let out = answer
  for (const url of dead) {
    const swap = own && !plainAddress(out).includes(plainAddress(own)) ? own.replace(/\)/g, '%29').replace(/ /g, '%20') : ''
    const link = new RegExp(`\\[([^\\]\\n]*)\\]\\(${literal(url)}[.,;:!?]*\\)`, 'g'), bare = new RegExp(`${literal(url)}(?![^\\s)\\]>"'|])`, 'g')
    out = out.split('\n').map(line => {
      const row = TABLE_ROW.test(line), done = line.replace(link, (_whole, name: string) => swap ? `[${sourceName(own!, korean)}](${swap})` : named && !row ? name : '').replace(bare, swap)
      return row && done !== line ? tidyCell(done) : done
    }).join('\n')
  }
  return out
}
export async function liveLinks(answer: string, read: readonly string[], alive: (url: string, signal: AbortSignal) => Promise<boolean>, korean = false, ms = LINK_CHECK_MS, swap: readonly string[] = read): Promise<string> {
  return declaredNamed(withoutDead(answer, await deadOf(unloaded(answer, read), alive, ms), swap, korean), korean)
}
export async function liveCited(answer: string, read: readonly string[], cite: (answer: string) => Promise<string> | string, alive: (url: string, signal: AbortSignal) => Promise<boolean>, korean = false, ms = LINK_CHECK_MS): Promise<string> {
  const dead = await deadOf(unloaded(`${answer}\n${await cite(answer.replace(ADDRESS, ''))}`, read), alive, ms)
  const row = /^\s*\|.*\|\s*$/, cells = (line: string): string[] => line.trim().slice(1, -1).split('|').map(cell => cell.trim())
  const was = withoutDead(answer, dead, read, korean).split('\n'), bare = withoutDead(answer, dead, read, korean, false).split('\n')
  const rows = (await cite(was.map((line, i) => row.test(line) ? bare[i]! : line).join('\n'))).split('\n').map((line, i) => {
    const had = was[i]
    if (had === undefined || !row.test(had) || !row.test(line)) return line
    return dead.some(url => line.includes(url) && !had.includes(url)) || bare[i] !== had && !/https?:\/\//.test(cells(line).at(-1)!) ? `| ${[...cells(line).slice(0, -1), cells(had).at(-1)!].join(' | ')} |` : line
  })
  const out = declaredNamed(withoutDead(rows.join('\n'), dead, read, korean), korean)
  return out.replace(/\n\n(출처|Sources): ([^\n]*)$/, (_whole, label: string, items: string) => { const kept = items.split(' · ').filter(item => /\]\(https?:\/\//.test(item)); return kept.length ? `\n\n${label}: ${kept.join(' · ')}` : '' })
}
export const NO_LIVE_SOURCE = '(no live source)'
export async function withLiveSources(members: TeamMember[], alive: (url: string, signal: AbortSignal) => Promise<boolean>, ms = LINK_CHECK_MS): Promise<boolean> {
  const cited = (m: TeamMember): string[] => [...new Set([...addressesIn(m.result ?? ''), ...(m.sources ?? [])])]
  const dead = new Set(await deadOf([...new Set(members.flatMap(cited))], alive, ms))
  if (!dead.size) return false
  const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), words = (line: string): string => line.replace(ADDRESS, ' ')
  let changed = false
  for (const m of members) {
    const fix = (text: string): string => { const lines = text.split('\n'); return lines.map(line => {
      const gone = addressesIn(line).filter(url => dead.has(url))
      if (!gone.length) return line
      const figures = (words(line).match(/\d[\d,.]{2,}/g) ?? []).filter(figure => !m.brief.includes(figure))
      const live = (other: string): string | undefined => addressesIn(other).filter(url => !dead.has(url)).sort((a, b) => Number(isSearchPage(a)) - Number(isSearchPage(b)))[0]
      const said = (text: string): string[] => figures.reduce((rest, figure) => rest.split(figure).join(' '), words(text)).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
      const claim = said(line), stem = (w: string) => (t: string): boolean => t.startsWith(w) && /^[가-힣]*$/.test(t.slice(w.length))
      const subject = [...claim, ...said(m.brief)], head = (other: string): string => { const text = words(other), at = Math.min(...figures.map(figure => text.indexOf(figure)).filter(i => i >= 0)); return text.slice(0, at) }
      const same = (other: string): boolean => { const has = said(other); return claim.every(w => has.some(stem(w))) && said(head(other)).every(t => subject.some(w => stem(w)(t) || stem(t)(w))) }
      const to = figures.length ? lines.map(other => other !== line && figures.some(figure => words(other).includes(figure)) && same(other) ? live(other) : undefined).find(Boolean) : undefined
      return gone.reduce((text, url) => text.replace(new RegExp(`\\[([^\\]\\n]*)\\]\\(${literal(url)}\\)`, 'g'), to ? `[${sourceName(to, /[가-힣]/.test(m.brief))}](${to})` : NO_LIVE_SOURCE).split(url).join(to ?? NO_LIVE_SOURCE), line)
    }).join('\n') }
    const fixed = fix(m.result ?? ''), said = m.said === undefined ? undefined : fix(m.said)
    const sources = m.sources?.filter(url => !dead.has(url))
    if (fixed !== m.result || said !== m.said || sources?.length !== m.sources?.length) { changed = true; m.result = fixed; if (said !== undefined) m.said = said; if (sources?.length) m.sources = sources; else delete m.sources }
  }
  return changed
}
export function citeOwn(answer: string, read: readonly string[], korean = false): string {
  const replies = /(?:\s*\n-{3,})?\s*```replies[^]*$/.exec(answer)?.[0]
  if (replies) return citeOwn(answer.slice(0, -replies.length), read, korean) + replies
  answer = placeNamed(answer, [], korean, true)
  const lone = /^([^]*\S)\s*\n\s*(\[[^\]\n]+\]\(https?:\/\/[^)\n]+\))\s*$/.exec(answer)
  if (lone && !/^\s*([|>#*+-]|\d+[.)]\s|```)/.test(lone[1]!.split('\n').at(-1)!)) return `${lone[1]} ${lone[2]}`
  if (!answer.trim() || !read.length || /https?:\/\//.test(answer)) return answer
  const url = sourcesOf(read)[0]!, link = `[${sourceName(url, korean)}](${url.replace(/\)/g, '%29').replace(/ /g, '%20')})`
  const text = answer.trimEnd(), last = text.split('\n').at(-1)!
  return /^\s*([|>#*+-]|\d+[.)]\s|```)/.test(last) ? `${text}\n\n${link}` : `${text} ${link}`
}
export function keepRead(tool: AgentTool, into: string[]): AgentTool {
  const note = (args: Record<string, unknown>, out: string): void => {
    try {
      if (tool.name === 'search_web') {
        if (!/^results for "[^\n]*" at https?:\/\/\S+ \(DATA/.test(out)) return
        const lines = out.split('\n').slice(1).filter(line => !/^(?:Results, each as |The first \d+ are from the last |None is from the last |The last \d+ only mention )/.test(line))
        into.push(lines.map(line => { const [title, url, ...rest] = line.startsWith('- ') ? line.slice(2).split(' — ') : []; return title && url && /^https?:\/\//.test(url) ? `${title}${rest.length ? `: ${rest.join(', ')}` : ''} ${url}` : line }).join('\n').trim())
      } else if (tool.name === 'open_page') { if (out.startsWith('page "') && typeof args['url'] === 'string') into.push(`${out}\n${args['url']}`) }
      else if (tool.name === 'read_pages') for (const page of (JSON.parse(out.replace(/^that did not work: /, '')) as { pages?: { url?: unknown; ready?: unknown; observation?: unknown }[] }).pages ?? []) if (page.ready === true && typeof page.url === 'string' && typeof page.observation === 'string') into.push(`${page.observation}\n${page.url}`)
    } catch { }
  }
  if (!['search_web', 'open_page', 'read_pages'].includes(tool.name)) return tool
  return { ...tool, run: async (args, context) => { const out = await tool.run(args, context); note(args, out); return out }, ...(tool.runRich ? { runRich: async (args, context) => { const out = await tool.runRich!(args, context); note(args, out.text); return out } } : {}) }
}
const NOTHING_SAID = /찾지 못|못 찾|찾을 수 ?없|(?:소식|내용|정보|발표|결과|업데이트|자료|기능|기사|공지)[은는이가도]?\s*(?:전혀\s*|따로\s*|아직\s*)?(?:없|안 보|보이지 않)|확인되지 않|확인이\s*안\s*(?:됐|되)|안\s*잡히|(?:나오지|잡히지)\s*않|\b(?:no (?:new|recent|relevant)|nothing (?:new|relevant|found)|could ?n[o']t find|did ?n[o']t find)\b/iu
export const foundNothing = (answer: string): boolean => !!answer && answer.length <= 400 && !/https?:\/\//.test(answer) && NOTHING_SAID.test(answer)
const addressesIn = (text: string): string[] => (text.match(/https?:\/\/[^\s)\]>"'|]+/g) ?? []).map(url => url.replace(/[.,;:!?]+$/, ''))
function saidOnce(answer: string, job: string): string {
  const plain = answer.replace(/\s*```replies[^]*?(?:```|$)/g, '').trim(), [first = '', ...more] = plain.split(/\n\s*-{3,}\s*\n/), named = addressesIn(first)
  const numbers: string[] = first.match(/\d+/g) ?? []
  const titled = (half: string): boolean => { const head = /^\s*(?:#{1,6}\s+(.+)|\*\*([^*\n]+)\*\*\s*(?:\n|$))/.exec(half); return !!head && (head[1] ?? head[2])!.replace(/[*_:：]/g, ' ').split(/\s+/).filter(Boolean).every(word => job.includes(word) || /^(?:결과|정리|요약|내용|조사)$/u.test(word)) }
  const names = (text: string): string[] => (text.replace(/https?:\/\/\S+/g, ' ').match(/[A-Za-z]{2,}/g) ?? []).filter(word => !job.includes(word))
  const again = (half: string): boolean => { const mine = names(first); return names(half).some(word => mine.includes(word)) }
  const kept = more.filter(half => !titled(half) || !again(half) || addressesIn(half).some(url => !named.includes(url)) || (half.replace(/https?:\/\/\S+/g, ' ').match(/\d+/g) ?? []).some(n => !numbers.includes(n)))
  return kept.length === more.length ? plain : [first.trim(), ...kept.map(half => half.trim())].join('\n\n---\n\n')
}
const LIST_ASK = /일정|목록|리스트|schedule|\blist\b|(?:\d{1,2}|두|세|네|다섯)\s*(?:개|가지|건|편)(?![가-힣]*월)/iu
export const DATED_LINE = /\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}|(?<![\d.])\d{1,2}\/\d{1,2}(?![\d/])/
const datedLines = (text: string): number => text.split('\n').filter(line => DATED_LINE.test(line)).length
const ITEM_MARK = /^(?:[-*•·]|\d{1,2}[.)])\s/
const datesIn = (line: string): string[] => (line.match(new RegExp(DATED_LINE.source, 'g')) ?? []).map(day => day.replace(/\s+/g, ''))
const detail = (line: string): boolean => /^[-*•·]\s+[가-힣]{1,4}\s*[:：]/.test(line) && !datesIn(line).length
function itemsOf(lines: string[]): string[][] {
  const items: string[][] = []
  for (const line of lines) {
    const item = items.at(-1), days = datesIn(line), known = new Set(item?.flatMap(datesIn))
    if (!item || !detail(line) && (ITEM_MARK.test(line) || /https?:\/\/\S+\s*$/.test(item.at(-1)!) || days.length > 0 && !days.some(day => known.has(day)))) items.push([line])
    else item.push(line)
  }
  return items
}
export function keptItems(brief: string, text: string): string {
  const ask = brief.split('\n')[0]!
  if (!LIST_ASK.test(ask)) return text
  const said = (some: string[][]): boolean => some.some(item => /[가-힣A-Za-z]/.test(item.join(' ').replace(/https?:\/\/\S+/g, '')))
  const links = (item: string[]): string[] => item.flatMap(addressesIn)
  const items = itemsOf(text.split('\n')), real = items.some(item => links(item).some(url => !isSearchPage(url)))
  const kept = items.filter(item => !(real && links(item).length > 0 && links(item).every(isSearchPage)))
  return (said(kept) ? kept : items).flat().join('\n')
}
export function dataText(data: MemberData): string {
  const fact = (f: { text: string; url: string; date?: string }): string => `${datedText(f)} — ${f.url}`
  if (data.items?.length) return data.items.map((item, i) => `${i + 1}. ${item}`).join('\n')
  if (data.nothing) return ['이번엔 새로 나온 게 없어요.', ...(data.nothing.latest ? [`가장 최근: ${fact(data.nothing.latest)}`] : [])].join('\n')
  return data.facts.map(fact).join('\n')
}
const wholeSentences = (text: string): string => {
  const ends = [...text.matchAll(/(?:[.!?。]|\]\([^)\s]+\)|https?:\/\/[^\s)\]>"'|]+)(?=\s|$)/g)].at(-1)
  return ends ? text.slice(0, ends.index + ends[0].length).trim() : ''
}
export function settleMember(member: TeamMember, outcome: MemberOutcome, at: string, korean = false): void {
  const said = saidOnce(outcome.answer.trim(), member.brief.split('\n')[0]!)
  const read = outcome.error || outcome.asked ? '' : (outcome.read ?? '').trim()
  const answer = outcome.timedOut && (PROGRESS_ONLY.test(said) || !!read && WALLED.test(said)) ? '' : said
  member.finishedAt = at
  if (outcome.report !== undefined && !outcome.error && !outcome.asked) {
    const sources = sourcesOf(outcome.sources ?? []), data = outcome.report
    member.state = 'done'
    if (sources.length) member.sources = sources
    if (!data) { member.result = cut(said.replace(/```[a-z]*\s*\{[\s\S]*$/, '').trim(), MEMBER_RESULT_CHARS); return }
    member.data = data
    if (data.nothing) member.empty = true
    member.result = cut(dataText(data), MEMBER_RESULT_CHARS)
    if (member.lookup) member.review = { ok: true, note: AUTO_REVIEW }
    return
  }
  if (outcome.error || (!answer && !read)) { member.state = 'failed'; member.result = cut(`Failed: ${outcome.error ?? (outcome.timedOut ? 'it ran out of time before it reported anything.' : 'it ended without an answer.')}`, MEMBER_RESULT_CHARS); return }
  member.state = outcome.asked ? 'waiting' : 'done'
  const tail = outcome.budgetExhausted ? (korean ? '\n(처리 한도에서 멈춤)' : '\n(stopped at the token budget)') : outcome.timedOut ? (korean ? '\n(시간 한도에서 멈춤: 여기까지 찾은 내용)' : '\n(stopped at its time or call limit: this is what it had)') : ''
  const sources = sourcesOf(outcome.sources ?? [])
  const empty = !tail && (!!read || sources.length > 0) && !!member.lookup && foundNothing(answer)
  const unreached = read.split('\n').filter(line => !addressesIn(line).some(url => answer.includes(url))).join('\n').trim()
  const rest = !answer || empty ? read : tail && (!addressesIn(answer).length || (LIST_ASK.test(member.brief.split('\n')[0]!) && datedLines(answer) < datedLines(read))) ? unreached : ''
  if (rest) member.read = true
  if (empty) member.empty = true
  member.result = cut(keptItems(member.brief, [answer, rest].filter(Boolean).join('\n')), MEMBER_RESULT_CHARS - tail.length) + tail
  if (member.lookup) member.said = cut(keptItems(member.brief, tail ? wholeSentences(answer) : answer), MEMBER_RESULT_CHARS)
  if (sources.length) member.sources = sources
  const files = [...[...answer.matchAll(/\[([^\]]+)\]\(engram-artifact:[^)\s]+\)/g)].map(m => m[1]!), ...[...answer.replace(/https?:\/\/[^\s)\]>"'|]+/g, ' ').matchAll(DOC_FILE)].map(m => m[1]!).filter(file => !/^(?:www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)/i.test(file))]
  if (files.length) member.files = [...new Set(files)].slice(0, 10)
  else if (member.lookup && member.state === 'done' && !tail && answer && answeredLookup(answer, member.sources)) member.review = { ok: true, note: AUTO_REVIEW }
}

const MONEY = /\d[\d,.]*\s*(?:만\s?|천\s?|억\s?)?(?:원|달러|엔|유로|위안|파운드)|[$€₩¥£]\s?\d|\b(?:USD|KRW|EUR|JPY)\s?\d|\d\s?(?:USD|KRW|EUR|JPY|dollars?|won)\b/i
const PRICE_ASK = /가격|출고가|얼마|\bprice\b/i
export function priorPriceQuery(member: Pick<TeamMember, 'brief' | 'query'>, answer: string): string {
  const part = member.query || member.brief.split('\n')[0]!
  if (!PRICE_ASK.test(`${part} ${member.brief}`)) return ''
  const price = /(?:^|\n)[^\n]*?(?:가격|출고가|price)\s*[:：]([^\n]*)/i.exec(answer)?.[1]
  if (price === undefined || MONEY.test(price.replace(/https?:\/\/\S+/g, ' '))) return ''
  const thing = part.replace(/(?:의|와|과|이랑|랑|및|,)?\s*(?:가격|출고가|출시일|발매일|스펙|사양|조사|비교|price|release date)[^\n]*$/i, '').trim()
  const model = /^(.*?)(\d+)(\D*)$/.exec(thing)
  if (!model || Number(model[2]) < 2) return ''
  return `${model[1]}${Number(model[2]) - 1}${model[3]} ${/[가-힣]/.test(thing) ? '출고가' : 'launch price'}`.replace(/\s+/g, ' ').trim()
}
export function pointQueries(query: string): string[] {
  if (!/가격|출고가|\bprice\b/i.test(query) || !/출시일|출시|발매일|\brelease date\b/i.test(query)) return [query]
  const thing = query.replace(/(?:의|와|과|이랑|랑|및|,)?\s*(?:가격|출고가|출시일|출시|발매일|price|release date)(?:이랑|랑|과|와|및|,)?/gi, ' ').replace(/\s+/g, ' ').trim()
  return thing ? [`${thing} 출고가`, `${thing} 출시일`] : [query]
}
export function figurePages(answer: string, read: string): string {
  if (!read.trim()) return answer
  return answer.split('\n').map(line => {
    if (/https?:\/\//.test(line)) return line
    const page = figureSources(read, [line])[0]
    return page ? `${line.replace(/\s*[—–-]\s*(?:출처|source)\s*$/i, '')} — ${page}` : line
  }).join('\n')
}
export const PRIOR_PRICE_NOTE = 'Your price has no figure. Results of a search for the previous model\'s launch price follow. Write your whole answer again, the same lines, with the price line now carrying that figure with its currency, labeled 전작 ("전작 출시가 115만 원"), and the address it came from; change nothing else, and write no word about searching again.'

export const memberPersona = (member: TeamMember): string => `You are "${member.role}", a member of a hidden team working for one person through a lead. ${MEMBER_RULE}${member.lookup ? ` ${LOOKUP_RULE}` : ''}`

export const cutShortAnswer = (answer: string): string => /^Not verified as complete\.\n\nThe tool-call or time limit was reached\.\n\nUnverified response:\n/.test(answer) ? answer.slice(answer.indexOf('Unverified response:\n') + 21).trim() : answer

const OPTIONAL = /가능하면|가능하다면|가능한 경우|여유가? ?되면|시간이? ?되면|if possible|if time permits|if you have time|optionally|nice to have|as a bonus/i
export function withoutExtras(brief: string, personSaid: string): string {
  if (!OPTIONAL.test(brief) || OPTIONAL.test(personSaid)) return brief
  const kept = brief.split(/(?<=[.!?。\n,;])|(?=\()|(?<=\))/).filter(part => !OPTIONAL.test(part)).join('').replace(/[ \t]+\n/g, '\n').replace(/[,;]\s*$/, '').trim()
  return kept || brief
}

type Period = [words: RegExp, name: string, means: string, inQuery: boolean, from: Date, to: Date]
function periods(now: Date): Period[] {
  const day = (offset: number): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  const full = (at: Date): string => `${at.getFullYear()}년 ${at.getMonth() + 1}월 ${at.getDate()}일`
  const pair = (from: Date, to: Date, between: string, tags: [string, string] = ['', '']): string => `${full(from)}${tags[0]}${between}${to.getFullYear() === from.getFullYear() ? full(to).replace(/^\d+년 /, '') : full(to)}${tags[1]}`
  const month = (offset: number): string => { const at = new Date(now.getFullYear(), now.getMonth() + offset, 1); return `${at.getFullYear()}년 ${at.getMonth() + 1}월` }
  const monday = -((now.getDay() + 6) % 7)
  const months = (offset: number): [Date, Date] => [new Date(now.getFullYear(), now.getMonth() + offset, 1), new Date(now.getFullYear(), now.getMonth() + offset + 1, 0)]
  const years = (offset: number): [Date, Date] => [new Date(now.getFullYear() + offset, 0, 1), new Date(now.getFullYear() + offset, 11, 31)]
  return [
    [/다음\s?달|내달|\bnext month\b/i, '다음 달', month(1), true, ...months(1)],
    [/이번\s?달|이달|\bthis month\b/i, '이번 달', month(0), true, ...months(0)],
    [/지난\s?달|\blast month\b/i, '지난달', month(-1), true, ...months(-1)],
    [/내년|\bnext year\b/i, '내년', `${now.getFullYear() + 1}년`, true, ...years(1)],
    [/올해|금년|\bthis year\b/i, '올해', `${now.getFullYear()}년`, true, ...years(0)],
    [/이번\s?주말|\bthis weekend\b/i, '이번 주말', pair(day(monday + 5), day(monday + 6), ', ', ['(토)', '(일)']), false, day(monday + 5), day(monday + 6)],
    [/다음\s?주(?!말)|\bnext week\b/i, '다음 주', pair(day(monday + 7), day(monday + 13), '~'), false, day(monday + 7), day(monday + 13)],
    [/이번\s?주(?!말)|금주|\bthis week\b/i, '이번 주', pair(day(monday), day(monday + 6), '~'), false, day(monday), day(monday + 6)],
    [/내일|\btomorrow\b/i, '내일', full(day(1)), false, day(1), day(1)],
  ]
}
export const periodSpans = (text: string, now = new Date()): { name: string; from: Date; to: Date }[] => periods(now).filter(([words]) => words.test(text)).map(([, name, , , from, to]) => ({ name, from, to }))
export const periodsIn = (text: string, now = new Date()): [string, string][] => periods(now).filter(([words]) => words.test(text)).map(([, name, means]) => [name, means])
export function dateLine(text: string, now = new Date()): string {
  const named = periodsIn(text, now)
  return `Today is ${now.toLocaleDateString('sv-SE')} (${now.toLocaleDateString('en-US', { weekday: 'long' })}).${named.length ? ` Here ${named.map(([name, means]) => `${name} = ${means}`).join('; ')}: search and answer for that period, and say a year that is not this one.` : ''}`
}
const RELATIVE_TIME = /(?<![가-힣])(?:(?:이번|다음|지난|저번)\s?주말?|금주|주말|요즘|요새|최근|오늘|내일|모레|어제|지금|현재|방금|실시간)(?:에는|[은는엔에도의])?(?![가-힣])/gu
export const withoutRelativeTime = (words: string): string => words.replace(RELATIVE_TIME, ' ').replace(/\s+/g, ' ').trim()
export function datedQuery(query: string, about: string, now = new Date()): string {
  let out = query
  for (const [words, , means, inQuery] of periods(now)) if (inQuery) out = out.replace(words, means)
  for (const [, means] of periodsIn(`${about} ${query}`, now)) { const at = /^(\d{4})년 (\d{1,2})월$/.exec(means); if (at) out = out.replace(new RegExp(`(?<!\\d년\\s?|\\d)${at[2]}월`), means) }
  return out
}

export function memberTask(member: TeamMember, goal: string, redo?: MemberRedo, helpers: readonly TeamMember[] = [], now = new Date()): string {
  return [
    dateLine(`${member.brief} ${goal}`, now), '',
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

const askUp = (members: readonly TeamMember[]): string | undefined => { const asking = members.filter(m => m.state === 'waiting'); return asking.length ? formatAsk(asking.map(m => `${m.role}: ${m.result ?? ''}`).join('\n'), []) : undefined }
const accepted = (m: TeamMember): boolean => m.state === 'done' && (!!m.lookup && !m.files?.length || m.review?.ok === true && m.review.note === AUTO_REVIEW)
export function mergeReady(observation: string): boolean {
  try {
    const o = JSON.parse(observation) as { note?: unknown; members?: unknown }
    return typeof o.note === 'string' && o.note.startsWith(ACCEPTED_NOTE) && Array.isArray(o.members) && o.members.length > 0 && o.members.every(m => (m as { accepted?: unknown } | null)?.accepted === true)
  } catch { return false }
}
const measured = (brief: string, measure: string): string => measure ? `${brief}\n\nMeasure each compared point exactly this way, the same for every part: ${measure}. A value you can only find on another basis (another model or tier, unit or day) is given labeled with what it is.` : brief
const view = (m: TeamMember) => ({ id: m.id, role: m.role, state: accepted(m) ? 'released' : m.state, result: m.result ?? '', files: m.files ?? [], ...(m.sources?.length ? { sources: m.sources } : {}), ...(accepted(m) ? { accepted: true } : {}), ...(m.state === 'waiting' ? { ask: `${m.role}: ${m.result ?? ''}` } : {}) })
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max + 1) : ''

export const TAKEN_OFF = 'Taken off: the person changed the ask while it worked.'

export function teamHireTools(host: TeamHost): AgentTool[] {
  const open = new Map<string, Promise<void>>()
  let steerable = host.self === null && !!host.steered
  const took: string[] = []
  const collect = async (): Promise<string> => {
    const heard = new AbortController()
    const all = Promise.all([...new Set(open.values())])
    let steered = false
    try { steered = await Promise.race([all.then(() => false), steerable ? host.steered!(heard.signal).then(() => true) : new Promise<never>(() => undefined)]) } catch (error) { open.clear(); throw error } finally { heard.abort() }
    if (steered) steerable = false
    const team = (await host.load())?.team
    const mine = (team?.members ?? []).filter(m => open.size ? open.has(m.id) : took.includes(m.id))
    const working = (m: TeamMember): boolean => steered && (host.live(m.id) || m.state === 'hired' || m.state === 'working')
    const ended = mine.filter(m => !working(m))
    for (const m of ended) open.delete(m.id)
    const looked = host.alive ? ended.filter(m => m.lookup && m.state === 'done') : []
    const due = looked.length ? await host.due?.() : undefined
    if (looked.length && await withLiveSources(looked, host.alive!, due === undefined ? LINK_CHECK_MS : Math.max(0, Math.min(LINK_CHECK_MS, due - Date.now())))) await host.change(task => { for (const m of task.team?.members ?? []) { const fixed = looked.find(one => one.id === m.id); if (fixed) { m.result = fixed.result; if (fixed.sources?.length) m.sources = fixed.sources; else delete m.sources } } })
    const auto = ended.filter(accepted).map(m => m.id)
    if (auto.length) await host.change(task => { for (const m of task.team?.members ?? []) if (auto.includes(m.id) && !m.review) m.review = { ok: true, note: AUTO_REVIEW } })
    await host.release(auto)
    const hiresLeft = team ? team.maxHires - team.hires : 0
    if (steered) return JSON.stringify({ members: mine.map(m => working(m) ? { id: m.id, role: m.role, state: 'working' } : view(m)), hiresLeft, note: STEER_NOTE })
    const partial = ended.some(m => m.state === 'waiting') && ended.some(m => m.state === 'done')
    const settled = (m: TeamMember): boolean => accepted(m) || m.state === 'released'
    const base = partial ? PARTIAL_NOTE : ended.every(settled) ? ACCEPTED_NOTE : ended.some(settled) ? `${ACCEPTED_NOTE} For the others: ${REVIEW_NOTE}` : REVIEW_NOTE
    const note = `${ended.some(m => m.sources?.length) ? `${base} ${SOURCES_NOTE}` : base}${partial ? '' : ` ${MERGED_SHAPE}`}`
    return (partial ? undefined : askUp(ended)) ?? JSON.stringify({ members: ended.map(view), hiresLeft, note })
  }
  const hire: AgentTool = {
    name: 'hire_members',
    description: `Hire 1 to ${HIRE_MAX_PER_CALL} hidden team members for separable parts of this job and wait for their results. Each gets role (short name), brief (its whole part, complete on its own, in at most 3 short lines: what to find or make, for where or when; only what the person asked for, no optional "if possible" extras) and deliverable (one line: what it hands back). lookup true for a part that only looks things up and reports (web research, a fact check, reading notes): it runs fast with reading tools in about ten seconds, and its result comes back already accepted, with the pages it read in sources; leave it out for a part that makes or changes something. A lookup member also takes query: the search words you would type for its part, in the person's language ("아이폰 18 가격 출시일"); that search is run for it as it starts, and topic: the thing its part is about in the person's own words ("서울", "아이폰 18"), the name of its row in the answer. When the parts compare the same points (a price, a date, a rate, a score), measure is the one definition of each point that every part uses: the same tier or model, unit and basis ("가격: 기본 모델의 국내 출고가, 원 단위; 출시일: 국내 출시일"), so the values can be compared; every part gets it. notes carries only what you already know that they need. When every member is a lookup, the call returns the one answer to the person, already written from their results: it ends your turn. Never hire for a one-step ask unless the person asked for bots or members. Returns each member's result, files and state; review with review_member each one that is not already accepted.`,
    argsSchema: {
      type: 'object', additionalProperties: false, required: ['members'],
      properties: {
        members: { type: 'array', maxItems: HIRE_MAX_PER_CALL, items: { type: 'object', additionalProperties: false, required: ['role', 'brief'], properties: { role: { type: 'string' }, brief: { type: 'string' }, deliverable: { type: 'string' }, lookup: { type: 'boolean' }, query: { type: 'string' }, topic: { type: 'string' } } } },
        notes: { type: 'string' }, big: { type: 'boolean' }, measure: { type: 'string' }, stop: { type: 'array', items: { type: 'string' } },
      },
    },
    async run(args, context) {
      const asked = (Array.isArray(args['members']) ? args['members'] : []) as Record<string, unknown>[]
      const stop = (Array.isArray(args['stop']) ? args['stop'] : []).filter((id): id is string => typeof id === 'string' && took.includes(id))
      if (stop.length) {
        await host.release(stop)
        await host.change(task => { for (const m of task.team?.members ?? []) if (stop.includes(m.id)) { m.review = { ok: false, note: TAKEN_OFF }; delete m.result; delete m.data } })
        for (const id of stop) { open.delete(id); took.splice(took.indexOf(id), 1) }
      }
      if (!asked.length && (open.size || took.length)) return collect()
      const said = host.personSaid()
      const wanted = asked.map(m => ({ role: text(m?.['role'], 40), brief: withoutExtras(text(m?.['brief'], 1500), said), deliverable: withoutExtras(text(m?.['deliverable'], 300), said), lookup: m?.['lookup'] === true, query: text(m?.['query'], 120).slice(0, 120), topic: text(m?.['topic'], 40).replace(/[|()[\]]/g, ' ').trim().slice(0, 40) }))
      if (!wanted.length || wanted.length > HIRE_MAX_PER_CALL) throw new Error(`members needs 1 to ${HIRE_MAX_PER_CALL} entries, each with role, brief and deliverable.`)
      if (wanted.some(m => !m.role || m.role.length > 40 || !m.brief || m.brief.length > 1500 || m.deliverable.length > 300)) throw new Error('Each member needs role (1 to 40 characters), brief (1 to 1500) and deliverable (at most 300).')
      const notes = text(args['notes'], 1500).slice(0, 1500), measure = text(args['measure'], 300).slice(0, 300)
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
          if (team.planTurn !== undefined && task.turns > team.planTurn && TEAM_PLAN_YES.test(host.personSaid())) { team.approvedAt = new Date().toISOString(); logTask(task, 'Team plan approved') }
          else { team.big = true; team.planTurn = task.turns; return { refuse: PLAN_FIRST } }
        }
        task.team = team
        const at = new Date().toISOString()
        const ids = wanted.map(m => {
          const id = `m${team.members.length + 1}`
          team.members.push({ id, parentId: host.self, depth, role: m.role, brief: measured(notes ? `${m.brief}\n\nNotes from ${parent?.role ?? 'the lead'}:\n${notes}` : m.brief, measure), ...(m.deliverable ? { deliverable: m.deliverable } : {}), ...(m.lookup ? { lookup: true } : {}), ...(m.topic ? { topic: m.topic } : {}), ...(measure ? { measure } : {}), ...(m.lookup && m.query ? { query: datedQuery(m.query, `${m.brief} ${said}`) } : {}), state: 'hired', sessionKey: `team-${task.id}-${id}`, hiredAt: at })
          return id
        })
        team.hires += n
        logTask(task, `Hired ${wanted.map(m => m.role).join(', ')}`)
        return { ids }
      })
      if (!out) return 'No running task: nothing was hired.'
      if ('refuse' in out) return out.refuse
      took.push(...out.ids)
      const run = host.run(out.ids, context.signal)
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
        if (ok && member.state === 'released' && member.review?.ok) return { act: 'accept', role: member.role }
        if (!ok && member.state === 'released' && member.lookup) { member.review = { ok: false, note }; return { act: 'spent', role: member.role } }
        if (busy || !['done', 'failed', 'waiting'].includes(member.state)) return { refuse: `${member.role} is ${busy ? 'working' : member.state}; it can be reviewed once it has reported.` }
        if (ok) { member.review = { ok: true, note }; return { act: 'accept', role: member.role } }
        const answer = member.state === 'waiting'
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
