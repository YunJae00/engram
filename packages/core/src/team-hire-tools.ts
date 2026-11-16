import type { AgentTool } from './agent-loop.js'
import { formatAsk, parseAsk } from './ask.js'
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
export const MEMBER_BLOCKED = /^(new_bot|staff|assign|company_status|schedule|keep_in_mind|keep_how_to|offer_study|study_findings|report_result_check)$/
export const SCREEN_TOOL = /^(app_|desktop_|open_app|look_desktop|read_desktop|list_windows|excel_|word_|ppt_|outlook_|compose_live_document|edit_live_document|read_live_document)/
const TOKEN_REFUSAL = 'The task token budget is nearly used. Do not hire. Finish with what exists and close with what is done, what is missing and what comes next.'
const PLAN_FIRST = `Big team plan: nothing was hired. Show the plan to the person once before hiring: call ask_person with the members and what each delivers, options ["${TEAM_PLAN_OK[0]}", "${TEAM_PLAN_FIX[0]}"] in their language, and end this turn there. Hire after they agree in their next message. Their OK covers the plan only: sends, posts, purchases and deletions are still asked one by one.`
const PARTIAL_NOTE = 'Some members reported and some need the person (their "ask"). Do not end on the question alone: review the members that reported, give the person the combined answer from them now, say which part is missing, and close with the waiting member\'s question in the person\'s language. Leave the waiting member unreviewed; when the person answers, pass it with review_member({id, ok:false, note:<answer>}).'
// A lookup member that finished on its own and names its sources is accepted as it is: the lead reads it while merging. grokbar: three review_member rounds cost ~10 s.
export const AUTO_REVIEW = 'auto: sourced lookup'
const ACCEPTED_NOTE = 'Members with accepted true are sourced lookups, already accepted and released: do not call review_member for them. Report in one merged answer: several items go in one table, each row with the address it came from.'
const STEER_NOTE = 'The person wrote to you while the team worked; their words follow this result. Members with state working keep going. If their words add or change a part, call hire_members now for that part only; with nothing to add, call hire_members with members [] to wait. Either call also returns the members still working. Then give one answer that covers everything.'
const REVIEW_NOTE = 'Review each member with review_member before you report. A member that stopped at its time limit handed back what it had: accept it and say what is missing, and redo it only when the missing part is what the person asked for. A failed member delivered nothing: say that part is missing, or redo it once if the person asked for it. A member that needs the person is asked in your thread for you; when they answer, pass the answer with review_member({id, ok:false, note:<answer>}).'

// A lookup member (research, fact check, reading): a faster model, reading tools only, and a time box. perf146: three opus members with 65 tools
// each took 118-213 s on a weather lookup, one of them 90 s on an optional extra, and the lead waits for the slowest.
export const LOOKUP_TOOLS = new Set(['search_web', 'read_pages', 'open_page', 'read_open_page', 'look', 'reveal', 'search_memory', 'read_note', 'search_chats', 'ask_person'])
// After the soft limit no new tool call starts and the member reports what it has; at the hard limit it is stopped with what it wrote so far.
// perf146 r3: at 60 s / 80 s / 12 calls the members took 71-76 s of a 102 s answer; the lead waits for the slowest, so these bound the team.
// grokbar: at 40 s / 55 s / 10 calls three members took 36 s of a 71 s answer against a 35 s bar for the whole answer.
export const LOOKUP_SOFT_MS = 18_000
export const LOOKUP_HARD_MS = 24_000
export const LOOKUP_MAX_CALLS = 6
export const LOOKUP_RULE = 'You only look things up: you have reading tools and about twenty seconds. Search or open the most direct source first, read several pages at once with read_pages, and report as soon as the brief is answered, with the address of each page the facts came from (the page itself, never a search-results address). A page that wants a sign-in or a robot check is left alone, never worked around: read another source. If your part needs anything other than reading, say so in one line and stop.'

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

export interface MemberOutcome { answer: string; asked?: boolean; budgetExhausted?: boolean; timedOut?: boolean; error?: string }
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
export function answeredLookup(answer: string): boolean {
  const links = answer.match(/https?:\/\/[^\s)\]>"']+/g) ?? []
  if (!links.some(link => !SEARCH_PAGE.test(link)) || WALLED.test(answer)) return false
  const said = answer.replace(/https?:\/\/[^\s)\]>"']+/g, ' ').split(/(?<=[.!?…。])\s+|\n+/).filter(part => part.trim() && !PROGRESS_ONLY.test(part.trim())).join(' ').replace(/[\s\p{P}\p{S}]+/gu, '')
  return said.length >= 30 || /\d/.test(said) && said.length >= 4
}
// korean: the person's language, for the one line a cut-short result carries that the lead may show them.
export function settleMember(member: TeamMember, outcome: MemberOutcome, at: string, korean = false): void {
  const said = outcome.answer.trim(), answer = outcome.timedOut && PROGRESS_ONLY.test(said) ? '' : said
  member.finishedAt = at
  // A member with no answer delivered nothing, time-boxed or not: it is failed, never done. A "Failed: " result is kept out of what the person sees.
  if (outcome.error || !answer) { member.state = 'failed'; member.result = cut(`Failed: ${outcome.error ?? (outcome.timedOut ? 'it ran out of time before it reported anything.' : 'it ended without an answer.')}`, MEMBER_RESULT_CHARS); return }
  member.state = outcome.asked ? 'waiting' : 'done'
  const tail = outcome.budgetExhausted ? (korean ? '\n(처리 한도에서 멈춤)' : '\n(stopped at the token budget)') : outcome.timedOut ? (korean ? '\n(시간 한도에서 멈춤: 여기까지 찾은 내용)' : '\n(stopped at its time or call limit: this is what it had)') : ''
  member.result = cut(answer, MEMBER_RESULT_CHARS - tail.length) + tail
  const files = [...[...answer.matchAll(/\[([^\]]+)\]\(engram-artifact:[^)\s]+\)/g)].map(m => m[1]!), ...[...answer.matchAll(DOC_FILE)].map(m => m[1]!)]
  if (files.length) member.files = [...new Set(files)].slice(0, 10)
  else if (member.lookup && member.state === 'done' && !tail && answeredLookup(answer)) member.review = { ok: true, note: AUTO_REVIEW }
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
const view = (m: TeamMember) => ({ id: m.id, role: m.role, state: accepted(m) ? 'released' : m.state, result: m.result ?? '', files: m.files ?? [], ...(accepted(m) ? { accepted: true } : {}), ...(m.state === 'waiting' ? { ask: `${m.role}: ${m.result ?? ''}` } : {}) })
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max + 1) : ''

export function teamHireTools(host: TeamHost): AgentTool[] {
  // Members this caller hired in this turn and has not been handed back finished: an early return leaves some working.
  const open = new Map<string, Promise<void>>()
  // One early return per turn: words the turn does not take with the result (a check turn takes none) must not end every wait at once.
  let steerable = host.self === null && !!host.steered
  // Waits for the open members, or for the person's words to the lead, and hands back what there is.
  const collect = async (): Promise<string> => {
    const heard = new AbortController()
    const all = Promise.all([...new Set(open.values())])
    let steered = false
    try { steered = await Promise.race([all.then(() => false), steerable ? host.steered!(heard.signal).then(() => true) : new Promise<never>(() => undefined)]) } catch (error) { open.clear(); throw error } finally { heard.abort() }
    if (steered) steerable = false
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
    const note = partial ? PARTIAL_NOTE : ended.every(accepted) ? ACCEPTED_NOTE : ended.some(accepted) ? `${ACCEPTED_NOTE} For the others: ${REVIEW_NOTE}` : REVIEW_NOTE
    return (partial ? undefined : askUp(ended)) ?? JSON.stringify({ members: ended.map(view), hiresLeft, note })
  }
  const hire: AgentTool = {
    name: 'hire_members',
    description: `Hire 1 to ${HIRE_MAX_PER_CALL} hidden team members for separable parts of this job and wait for their results. Each gets role (short name), brief (its whole part, complete on its own, in at most 3 short lines: what to find or make, for where or when; only what the person asked for, no optional "if possible" extras) and deliverable (one line: what it hands back). lookup true for a part that only looks things up and reports (web research, a fact check, reading notes): it runs fast with reading tools in about twenty seconds, and a sourced result comes back already accepted; leave it out for a part that makes or changes something. notes carries only what you already know that they need. Never hire for a one-step ask unless the person asked for bots or members. Returns each member's result, files and state; review with review_member each one that is not already accepted.`,
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
        if ((!answer && member.review?.ok === false) || team.hires + 1 > team.maxHires) { member.review = { ok: false, note }; return { act: 'spent', role: member.role } }
        if (!answer) member.review = { ok: false, note }
        team.hires++; member.state = 'hired'; delete member.finishedAt
        return { act: answer ? 'answer' : 'redo', role: member.role }
      })
      if (!plan) return 'No running task.'
      if ('refuse' in plan) return plan.refuse
      const spent = `${plan.role} was already redone once (or the hire/token budget is used). Released with its last result; use it or do the rest yourself.`
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
