import {
  ANSWER_NOW, backgroundOpen, citeMembers, cutShortAnswer, failOnRestart, keepRead, timeBoxed, keepSources, LATE_CEILING_MS, listTasks, LOOKUP_MAX_CALLS, PRIOR_PRICE_NOTE, priorPriceQuery, figurePages, LOOKUP_TOOLS, MEMBER_BLOCKED, MEMBER_RESULT_CHARS, memberPersona, memberTask, releaseAll, runComet, SCREEN_TOOL, settleMember, skipWalls, TASK_TOKEN_BUDGET, TEAM_ANSWER_MS, teamHireTools, teamNote, unreviewed, updateTask,
  type AgentTool, type DelegatedTask, type Engine, type MemberOutcome, type MemberRedo, type TeamHost, type TeamMember, type ToolSessionJob, type VaultPaths,
} from 'core'
import type { Ask } from './page-actions.js'
import { asBackground, inCallerSlot, whileWaitingForPerson } from './worker-pool.js'
import { flog } from './flog.js'
import { isKorean } from './task-closing.js'
import { assignTool, inAskedPeriod, employeeNote, employeeWriteBack, isSearchPage, itemsPrompt, keptReportPrompt, kindChecked, listingPages, reportData, setReportLog, withItems, firstFound, firstSearches, type FirstSearch, handoffBrief, jobTitle, lateParts, followsLate, logTask, partOutcome, makerFirst, markLate, REPORT_WRITER_MS, WRITER_RULE, writesFromHandover } from 'core'

// Someone who writes from what was handed over (three lines of copy, a summary) has no tools and is stopped here with what they wrote.
// grokbar C6 has 45 s for a lookup (15 s at most) and then this.
export const WRITER_HARD_MS = 20_000
const OPENING_LINE_CHARS = 60
// c13a (cause T; C3: three teammates on a fixed 15 s clock from their own start were cut at 12-15 s with 14.5 s of the 35 s bar unused,
// and two parts were abandoned while the thread said they would follow). One clock per task, from the person's message: the answer is
// due TEAM_ANSWER_MS after it (taskDue). Every lookup reads the time left to that point; nothing counts a fixed time from its own start.
// - A helper whose lead writes the answer after it is due LEAD_ANSWER_MS earlier: the lead's merge round fits before the answer is due.
// - Every part has at least MIN_PART_MS from its own start (one queued, or added by a steer, is not cut before it worked); the task's
//   answer then waits for that part too (taskDue).
// - The soft point (no new tool call) and the answer reserve are shares of the part's own window. The reserve is never less than one
//   no-tool report round on the teammate's ~39-40k-character prompt (REPORT_ROUND_MS; a round with one tool call took 9.6-9.9 s in
//   C3): at that point a teammate that read something writes its report with no tools, and the quick model writes a stand-in from the
//   kept rows. A background part that can follow late is not cut at the deadline, so its report round may run past it.
// - At the deadline a background part that can be reported late (core lateParts) is not stopped: it stays working, is shown as such,
//   and its report follows in the same thread. LATE_CEILING_MS past the deadline it is stopped and recorded as not finished.
// All on the scale of the real deadline (the test seam answerMs shortens it).
const LEAD_ANSWER_MS = 6_000
const MIN_PART_MS = TEAM_ANSWER_MS / 2
const SOFT_SHARE = 0.5
const RESERVE_SHARE = 0.25
const REPORT_ROUND_MS = 6_000
// How long past the stop the quick model's report is waited for.
const ANSWER_GRACE_MS = 1_000
// c12a B3: one more round to take a listing page apart into items, only with at least this much of the teammate's time left.
const ITEMS_ROUND_MS = 6_000

// Runs the hidden team of a task: each member is its own engine turn on a lane of the lead's channel.
type Deps = Parameters<typeof runComet>[0]
type Native = NonNullable<Parameters<typeof runComet>[2]>['native']
// stack-7: the host runs a first search in two places: for a lone lookup (ipc.ts, c7 fast-lane firstSearch) and for a teammate with
// search words (below, c6). A lone lookup that then hires must never run both for the same words: what the lead's turn already found
// is kept here by its thread, and a teammate hired in that turn with the same words starts from it, with no second search.
export const laneSearches = new Map<string, { query: string; found: string }>()
const sameWords = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()
export const memberLane = (channel: string, id: string): string => `${channel}~team-${id}`
export const laneMember = (lane: string): RegExpExecArray | null => /^(bot-[^~]+)~team-(m\d+)$/.exec(lane)
export const leadOf = (lane: string): string => laneMember(lane)?.[1] ?? lane

// What one lead or member turn hands over so its members can be run the same way.
export interface TurnKit {
  engine: Deps['engine']; workdir: Deps['workdir']; guided: boolean; said(): string
  // c13b: the host's link check, for the pages a member cites as its result is handed over (core TeamHost.alive).
  alive?(url: string, signal: AbortSignal): Promise<boolean>
  nativeFor(lane: string): Promise<Native>
  toolsFor(lane: string, native: Native): Promise<AgentTool[]>
}

const TERMINAL = ['done', 'failed', 'stopped']
const reviewFirst = (open: TeamMember[]) => `You reported without reviewing the helpers you hired: ${open.map(m => `${m.role} (${m.id})`).join(', ')}. Read what each returned, call review_member for each one, then report your result again.`

export function teamRunner(deps: {
  paths: VaultPaths
  askFor(channel: string, confirm: Ask, waitMs?: number): Ask | undefined
  waitingForPerson(channel: string): boolean
  closeSession(key: string): void
  endLane(lane: string): void
  step(channel: string, line: string): void
  changed(): void
  // Resolves when the person says something in this lead's thread mid-turn (a lead waiting on its members hears it at once).
  steered?(channel: string, signal: AbortSignal): Promise<void>
  /** A conversation has a turn of its own under way: an agent's finished job is written to their conversation after it. */
  busy?(channel: string): boolean
  run?: typeof runComet
  // Test seam: how long after the person's message the team's answer is due (TEAM_ANSWER_MS); every other time scales with it.
  answerMs?: number
}) {
  const { paths } = deps
  const answerMs = deps.answerMs ?? TEAM_ANSWER_MS, scale = answerMs / TEAM_ANSWER_MS
  // When a task's answer is due: its message time plus the answer time, or later when a part started late still needs its least time.
  const taskDue = (task: DelegatedTask): number => Math.max(Date.parse(task.createdAt) + answerMs, ...(task.team?.members ?? []).filter(m => m.parentId === null && !!m.botId && m.background).map(m => Date.parse(m.hiredAt) + MIN_PART_MS * scale))
  // What each part at work has opened so far: put on the member when the others are reported without it (rule 7's line links it).
  const reading = new Map<string, Set<string>>()
  setReportLog(line => flog('team-report', line))
  const live = new Map<string, { control: AbortController; channel: string }>()
  const waitingLanes = new Map<string, number>()
  const inflight = new Map<string, number>()
  const screen = new Map<string, string>()
  const notes = new Map<string, string>()
  const roles = new Map<string, string>()
  // Lead channels being stopped: a member that ends because of the stop leaves no late result; the stop releases it.
  const halting = new Set<string>()
  // The lead's running tool session per lead channel: member tokens count against the lead's turn budget, so lead plus team never pass it.
  const leads = new Map<string, { job: ToolSessionJob; spent: number }>()
  // Told when the background members of a task have all ended: the lead reports in a turn of its own (task-runner report).
  let report: ((channel: string, taskId: string) => void) | undefined
  // What a task's background members were started with: a part added while they work starts the same way (steer).
  const laterKits = new Map<string, TurnKit>()
  // Tasks whose lead was told: two batches of one task that end together are one report (a part added mid-work is a batch of its own).
  const told = new Set<string>()
  const charge = (leadChannel: string, tokens: number) => { const lead = leads.get(leadChannel); if (!lead) return false; lead.spent += tokens; lead.job.onUsage?.(tokens); return true }
  const channelOf = (task: DelegatedTask) => `bot-${task.botId}`
  const now = () => new Date().toISOString()
  const find = async (taskId: string) => (await listTasks(paths)).find(t => t.id === taskId)
  const remember = (task: DelegatedTask) => { if (task.team && !TERMINAL.includes(task.state)) notes.set(channelOf(task), teamNote(task.team)); else notes.delete(channelOf(task)) }
  async function change<T>(taskId: string, work: (task: DelegatedTask) => T): Promise<T | undefined> {
    let out: T | undefined
    const task = await updateTask(paths, taskId, t => { out = work(t) })
    if (task) remember(task)
    deps.changed()
    return task ? out : undefined
  }
  const tokensLeft = async (taskId: string) => { const task = await find(taskId); return TASK_TOKEN_BUDGET - (task?.tokensUsed ?? 0) - (task ? leads.get(channelOf(task))?.spent ?? 0 : 0) - (inflight.get(taskId) ?? 0) }

  async function release(taskId: string, ids: string[]): Promise<void> {
    if (!ids.length) return
    const keys = await change(taskId, task => (task.team?.members ?? []).filter(m => ids.includes(m.id) && m.state !== 'released').map(m => { m.state = 'released'; m.finishedAt ??= now(); return m.sessionKey }))
    for (const key of keys ?? []) deps.closeSession(key)
  }

  // At most one member of a task drives the screen; a second one is refused rather than queued, so a parent cannot block its own helper.
  function screenGuard(tool: AgentTool, taskId: string, member: TeamMember): AgentTool {
    if (!SCREEN_TOOL.test(tool.name)) return tool
    const take = () => {
      const holder = screen.get(taskId)
      if (holder && holder !== member.id) throw new Error(`${roles.get(`${taskId}/${holder}`) ?? holder} is using the screen. Do the parts that need no screen, or report that the screen was busy.`)
      screen.set(taskId, member.id)
    }
    return { ...tool, run: async (args, context) => { take(); return tool.run(args, context) }, ...(tool.runRich ? { runRich: async (args, context) => { take(); return tool.runRich!(args, context) } } : {}) }
  }

  async function runOne(taskId: string, leadChannel: string, id: string, signal: AbortSignal | undefined, kit: TurnKit, budget: number, redo?: MemberRedo): Promise<void> {
    const key = `${taskId}/${id}`, lane = memberLane(leadChannel, id)
    const control = new AbortController(), stop = () => control.abort()
    if (signal?.aborted) control.abort(); else signal?.addEventListener('abort', stop, { once: true })
    live.set(key, { control, channel: leadChannel })
    let used = 0, role = id, goal = '', due = Date.now() + answerMs, ended: TeamMember['state'] | undefined, done: { botId: string; brief: string; result: string; title?: string } | undefined
    // Tokens a lead session already counts are saved with the lead's turn, not again here.
    let charged = leads.has(leadChannel)
    try {
      const member = await change(taskId, task => { const m = task.team?.members.find(one => one.id === id); goal = task.goal; due = taskDue(task); if (m?.state === 'hired' && (task.state === 'running' || (m.background && !TERMINAL.includes(task.state)))) { m.state = 'working'; return { me: structuredClone(m), helpers: redo ? structuredClone(unreviewed(task.team, id)) : [] } } return undefined })
      if (!member) return
      const { me, helpers } = member
      // A helper's lead writes the answer after it: it is due that much earlier.
      if (!me.botId) due -= LEAD_ANSWER_MS * scale
      role = me.role; roles.set(key, role)
      // A background member outlives the lead's turn: its tokens are saved with the task, never against a lead session that may be gone.
      if (me.background) charged = false
      // An agent on the team works as themselves: their role and what they remember ride with the member rules.
      // c11a: a lookup or a writer on the team hands back data (core REPORT_RULE / WRITER_RULE); a writer's deliverable carries no temperament.
      const persona = memberPersona(me) + (me.botId ? await employeeNote(paths, me.botId, undefined, me.writer ? 'writer' : me.lookup ? 'lookup' : undefined) : '') + (me.writer ? ` ${WRITER_RULE}` : '')
      let outcome: MemberOutcome
      // A lookup member is time-boxed by the task's one deadline (taskDue, c13a); a writer by its own time from when it starts.
      // Its window counts from when its session starts: one still in line is not stopped before it began (perf146 r2).
      let timedOut = false, draft = '', read = false, hardStop: ReturnType<typeof setTimeout> | undefined, whole: MemberOutcome | undefined
      const sources = new Set<string>(), kept: string[] = []
      reading.set(key, sources)
      let startedAt: number | undefined, stopAt = Infinity, reserveMs = 0
      // A teammate's tool rounds run on their own signal: the answer reserve ends a round without ending the teammate.
      const toolRound = new AbortController()
      control.signal.addEventListener('abort', () => toolRound.abort(), { once: true })
      const quick = kit.engine.id === 'claude' && kit.engine.quick ? (prompt: string, ms = REPORT_WRITER_MS) => kit.engine.quick!(prompt, { workdir: kit.workdir, timeoutMs: ms }) : undefined
      let answering = false, reserve: ReturnType<typeof setTimeout> | undefined, written: Promise<string | undefined> | undefined
      // stack-12 (T3): no wait after a teammate's own work (the stand-in report, the kind check) outlives a stop or a steer. The hard
      // limit aborts the same signal, but it sets timedOut first and its stand-in keeps its grace.
      const stopped = new Promise<undefined>(resolve => control.signal.addEventListener('abort', () => { if (!timedOut) resolve(undefined) }, { once: true }))
      const readSome = (): boolean => kept.length > 0 || [...sources].some(url => !isSearchPage(url))
      const answerNow = () => {
        if (control.signal.aborted || !readSome()) return
        written = quick?.(keptReportPrompt(me.brief, kept), reserveMs + ANSWER_GRACE_MS * scale).catch(() => undefined)
        // Already writing its report block: that answer is let finish.
        if (/```|^\s*\{/.test(draft)) return
        answering = true; toolRound.abort()
      }
      const cut = (): void => { timedOut = true; control.abort() }
      // At the deadline a background part that can follow on its own (core lateParts / followsLate: the others are reported without it)
      // keeps working until the ceiling; any other part, a hand-off's too, stops there with what it has.
      const atDue = async (): Promise<void> => {
        const task = await find(taskId).catch(() => undefined), m = task?.team?.members.find(one => one.id === id)
        if (!task || !m?.background || !me.botId || control.signal.aborted || !followsLate(m) || !(m.late || lateParts(task).includes(id))) return cut()
        stopAt = due + LATE_CEILING_MS * scale
        hardStop = setTimeout(cut, Math.max(0, stopAt - Date.now()))
      }
      const begun = () => {
        if (!(me.lookup || me.writer) || startedAt !== undefined) return
        startedAt = Date.now()
        if (me.writer) { stopAt = startedAt + WRITER_HARD_MS; hardStop = setTimeout(cut, WRITER_HARD_MS); return }
        due = Math.max(due, startedAt + MIN_PART_MS * scale)
        stopAt = due
        const window = due - startedAt
        reserveMs = Math.min(window, Math.max(REPORT_ROUND_MS * scale, window * RESERVE_SHARE))
        hardStop = setTimeout(() => void atDue(), window)
        if (me.botId) reserve = setTimeout(answerNow, window - reserveMs)
      }
      // Time until the deadline on the real scale: a lookup's tools run only while a call and the answer after it still fit (timeBoxed).
      const left = (): number => (due - Date.now()) / scale
      // The soft point: after this share of its window a lookup starts no new tool call and answers from what it has.
      const soft = (): number => { const from = startedAt ?? Date.now(); return Math.max(0, (Math.max(due, from + MIN_PART_MS * scale) - from) * SOFT_SHARE) }
      let tools: AgentTool[] = []
      const drafted = { onToken: (text: string) => { begun(); draft += text }, onReset: () => { draft = '' } }
      try {
        // Reading tools only and no shell for a lookup member: a small menu the model sees whole.
        const native = me.lookup || me.writer ? undefined : await kit.nativeFor(lane)
        tools = me.writer ? [] : (await kit.toolsFor(lane, native)).filter(tool => !MEMBER_BLOCKED.test(tool.name) && (!me.lookup || LOOKUP_TOOLS.has(tool.name))).map(tool => screenGuard(me.lookup ? timeBoxed(keepRead(keepSources(skipWalls(tool), sources), kept), left) : tool, taskId, me))
        let prompt = memberTask(me, goal, redo, helpers)
        // c6 R2/R1/T1: the round before a member's first search cost 3.4-4 s in every member. The search the lead gave words for is run
        // here, by the member's own search tool (so its sources, kept rows, news period and ranking apply), and its results open the task.
        // The time counts against the member's limit. A search that did not run, or met a wall, leaves the task as it was.
        // shortcut: the search runs before the session opens, not beside it (~1.2 s of start-up is not overlapped); warm the session first if that matters.
        // stack-6: a teammate that runs the same search again after it keeps those rows once (settleMember below).
        const search = me.lookup && me.query && !redo ? tools.find(tool => tool.name === 'search_web') : undefined
        if (search) {
          begun()
          // The lead's own turn already ran these words: the same results, fed through the same keeping (sources, rows), not fetched again.
          const held = laneSearches.get(leadChannel), task = prompt
          // c9 C3/C5 + c9a R2: a job about a product's updates, a list job, or a price-and-date ask opens with up to three searches (core
          // firstSearches, the one helper). One after the other: a member's searches share its one tab, and a second load cuts the first
          // off (stack-6, comet-navigation-tools). The maker's own rows come first; that one page is the one to read.
          const founds: (FirstSearch & { found: string; own?: boolean })[] = []
          for (const one of firstSearches(me, goal)) {
            const already = held && sameWords(held.query, one.query) ? held.found : undefined, args = { query: one.query, ...(one.news ? { kind: 'news' } : {}) }
            const found = already !== undefined ? await keepRead(keepSources({ ...search, run: async () => already }, sources), kept).run(args, { task, signal: control.signal }).catch(() => '') : await search.run(args, { task, signal: control.signal }).catch(() => '')
            if (/^results for "/.test(found)) founds.push({ ...one, ...(one.maker ? makerFirst(found, one.maker) : { found }) })
          }
          if (founds.length) { read = true; prompt += firstFound(founds) }
        }
        let priced = false
        for (let round = 0; ; round++) {
          const result = await (deps.run ?? runComet)({ engine: kit.engine, workdir: kit.workdir, tools }, prompt, {
            signal: toolRound.signal, persona, session: me.sessionKey, guided: kit.guided, tokenBudget: Math.max(0, budget - used),
            onStart: begun,
            onUsage: tokens => { begun(); used += tokens; if (!(charged && charge(leadChannel, tokens))) inflight.set(taskId, (inflight.get(taskId) ?? 0) + tokens) },
            ...(native ? { native } : {}),
            waitingForPerson: () => waitingLanes.has(lane) || deps.waitingForPerson(leadChannel),
            onStep: line => { read = true; deps.step(leadChannel, line) },
            ...(me.lookup ? { modelHint: 'smart' as const, lookup: true, maxCalls: LOOKUP_MAX_CALLS, deadlineMs: soft(), ...drafted } : me.writer ? { modelHint: 'smart' as const, ...drafted } : {}),
          })
          const cutShort = !!me.lookup && result.stopped === 'calls' && !result.asked
          outcome = { answer: cutShort ? cutShortAnswer(result.answer) : result.answer, ...(result.asked ? { asked: true } : {}), ...(result.budgetExhausted ? { budgetExhausted: true } : {}), ...(cutShort ? { timedOut: true } : {}) }
          // c7 R2: a price reported with no figure gets one host-run search for the previous model's launch price and one more round
          // to write it in (team-hire-tools priorPriceQuery), once, and only while the search and that round still fit the member's time.
          // The search is the member's own time-boxed one: with too little time left for it and the answer it is not run.
          whole = undefined
          const prior = !priced && search && !result.asked && !result.budgetExhausted && !control.signal.aborted ? priorPriceQuery(me, outcome.answer) : ''
          if (prior && search) {
            priced = true
            const found = await search.run({ query: prior }, { task: prompt, signal: control.signal }).catch(() => '')
            // Stopped at the hard limit while writing it again, the member keeps the answer it had.
            if (/^results for "/.test(found)) { whole = outcome; draft = ''; prompt = `${PRIOR_PRICE_NOTE}\n${found}`; round--; continue }
          }
          // A member reports up only after it reviewed its own helpers; it gets one reminder.
          const open = unreviewed((await find(taskId))?.team, id)
          if (!open.length || result.asked || result.budgetExhausted || toolRound.signal.aborted) break
          if (round) { outcome = { answer: '', error: `it reported without reviewing ${open.map(m => m.role).join(', ')}.` }; break }
          prompt = reviewFirst(open)
        }
      } catch (error) { outcome = { answer: '', error: error instanceof Error ? error.message : String(error) } }
      // The reserve ended its round: one round with no tools, to write the report from what it read (the tool path's own ANSWER_NOW).
      const turn = (task: string, roundTools: AgentTool[]) => (deps.run ?? runComet)({ engine: kit.engine, workdir: kit.workdir, tools: roundTools }, task, {
        signal: control.signal, persona, session: me.sessionKey, guided: kit.guided, tokenBudget: Math.max(0, budget - used), modelHint: 'smart' as const, ...drafted,
        onUsage: tokens => { used += tokens; if (!(charged && charge(leadChannel, tokens))) inflight.set(taskId, (inflight.get(taskId) ?? 0) + tokens) },
      })
      if (answering && !control.signal.aborted) {
        draft = ''
        try { outcome = { answer: (await turn(`${ANSWER_NOW} Write it as the report block your rules describe. What you read:\n${kept.join('\n\n').slice(0, 6000)}`, [])).answer } } catch { outcome = { answer: '' } /* Cut at the hard limit, what it wrote by then is in draft; else the quick model's report stands in. */ }
      }
      clearTimeout(reserve)
      // What it had written at the hard stop is its result, whether or not it called a tool first (grokbar C6: three lines of copy written with
      // no tool call were thrown away as "조사하지 못했어요"). Only a lookup's one short line before its first tool call is still an opening line,
      // not findings (perf146 r3: "먼저 기상청부터 확인.").
      const opening = !!me.lookup && !read && !draft.trim().includes('\n') && draft.trim().length <= OPENING_LINE_CHARS
      if (timedOut && !signal?.aborted) outcome = whole ?? { answer: opening ? '' : draft, timedOut: true }
      else if (control.signal.aborted) outcome = { answer: '', error: 'it was stopped.' }
      // c11a: a teammate's result is the report block it wrote; with none (or a broken one) it is null, and its prose is never parsed.
      // Its list keeps only items of the kind asked, judged here once by the quick model (core kindChecked), before anything shows it.
      const structured = !!me.botId && (!!me.lookup || !!me.writer) && !outcome.error && !outcome.asked
      let data = structured ? reportData(outcome.answer, me, [...sources], isKorean(goal)) : undefined
      // c12a A1: with no report by the limit, the quick model's report from the kept rows, waited for until the limit plus the grace.
      if (structured && !data && written) {
        let wait: ReturnType<typeof setTimeout> | undefined
        const by = Math.max(0, Math.min(stopAt, Date.now() + reserveMs) + ANSWER_GRACE_MS * scale - Date.now())
        data = reportData(await Promise.race([written, stopped, new Promise<undefined>(resolve => { wait = setTimeout(() => resolve(undefined), by) })]) ?? '', me, [...sources], isKorean(goal))
        clearTimeout(wait)
      }
      // A part cut at its limit has no time for the kind check's model, as before; a stopped one has none at all.
      const judge = (prompt: string, ms?: number) => Promise.race([quick!(prompt, ms), stopped])
      data = await kindChecked(inAskedPeriod(data, me.brief), me.brief, timedOut || control.signal.aborted || !quick ? undefined : judge)
      // c12a B3: a listing page among the facts is taken apart in one more round while the teammate's time allows it (the hard stop still
      // applies); otherwise it stays, labeled where it is shown.
      const pages = me.lookup && !timedOut && !control.signal.aborted ? listingPages(data) : []
      if (data && pages.length && left() >= ITEMS_ROUND_MS) {
        draft = ''
        const more = await turn(itemsPrompt(pages), tools).then(out => reportData(out.answer, me, [...sources], isKorean(goal))).catch(() => undefined)
        // stack-12 (c12a r3 #2): the round's items are judged like the first ones; a page summary given back again is no item.
        data = withItems(data, await kindChecked(more, me.brief, timedOut || control.signal.aborted || !quick ? undefined : judge))
      }
      clearTimeout(hardStop)
      reading.delete(key)
      const report = structured ? data ?? null : undefined
      await change(taskId, task => {
        if (!charged) task.tokensUsed = (task.tokensUsed ?? 0) + used
        const m = task.team?.members.find(one => one.id === id)
        // c9a R2: a fact the teammate gave with no address is tied to the row it read it from (figurePages).
        if (me.lookup && !me.botId && outcome.answer && kept.length) outcome = { ...outcome, answer: figurePages(outcome.answer, kept.join('\n')) }
        if (m && m.state !== 'released' && !(control.signal.aborted && !timedOut && halting.has(leadChannel))) {
          settleMember(m, { ...outcome, ...(sources.size ? { sources: [...sources] } : {}), ...(kept.length ? { read: [...new Set(kept)].join('\n\n') } : {}), ...(report !== undefined ? { report } : {}) }, now(), isKorean(goal))
          // c13a: a teammate that hands back data and ended with none is not finished (status and record read this, never "found nothing").
          if (m.botId && (me.lookup || me.writer) && !m.data && (m.state === 'done' || m.state === 'failed')) m.unfinished = true
        }
        ended = m?.state
        // Every part that ended goes on the record, one that found nothing too (grokbar C10: a hand-off that failed left no line). One the person stopped does not.
        if (m?.botId && (ended === 'done' || (ended === 'failed' && (timedOut || !control.signal.aborted)))) done = { botId: m.botId, brief: m.brief, result: ended === 'done' && !m.empty && partOutcome(m) !== 'unfinished' ? m.result ?? '' : '', ...(m.title ? { title: m.title } : {}), ...(ended === 'done' && m.data ? { data: m.data } : {}) }
      })
      if (done) {
        // An agent mid-turn in their own conversation gets the job on their record when that turn ends; nobody here waits for it.
        const busy = () => deps.busy?.(`bot-${done!.botId}`) ?? false, wrote = employeeWriteBack(paths, done, undefined, busy).catch(error => flog('team', error))
        if (!busy()) await wrote
      }
    } catch (error) { flog('team', error) } finally {
      signal?.removeEventListener('abort', stop)
      live.delete(key)
      if (!charged) { const left = (inflight.get(taskId) ?? 0) - used; if (left > 0) inflight.set(taskId, left); else inflight.delete(taskId) }
      if (screen.get(taskId) === id) screen.delete(taskId)
      // A member waiting on the person keeps its helpers for review when it resumes; any other end passes them up unreviewed, said so.
      if (ended !== 'waiting' && !halting.has(leadChannel)) await orphan(taskId, id, ended).catch(error => flog('team', error))
      deps.endLane(lane)
      deps.step(leadChannel, isKorean(goal) ? `${role} 끝` : `${role} finished`)
    }
  }

  // A member, then whoever its result is handed to (TeamMember.then): one hop, only after it ended done, and it counts as a hire.
  async function chain(taskId: string, leadChannel: string, id: string, signal: AbortSignal | undefined, kit: TurnKit, budget: number, redo?: MemberRedo): Promise<void> {
    await runOne(taskId, leadChannel, id, signal, kit, budget, redo)
    if (redo) return
    const next = await change(taskId, task => {
      const team = task.team, m = team?.members.find(one => one.id === id)
      if (!team || !m?.then || m.state !== 'done' || team.hires >= team.maxHires) return undefined
      const to = `m${team.members.length + 1}`
      // The next one's own job decides how they run: writing from what was handed over needs no web (grokbar C6).
      team.members.push({ id: to, parentId: m.parentId, depth: m.depth, role: m.then.who, brief: handoffBrief(m.then.brief, m.role, m.result ?? '', m.brief), botId: m.then.botId, ...(m.then.voice ? { voice: m.then.voice } : {}), title: jobTitle(m.then.brief), ...(writesFromHandover(m.then.brief) ? { writer: true as const } : { lookup: true }), ...(m.background ? { background: true as const } : {}), ...(m.late ? { late: true as const } : {}), state: 'hired', sessionKey: `team-${task.id}-${to}`, hiredAt: now() })
      team.hires++
      logTask(task, `${m.role} handed over to ${m.then.who}`)
      return { to, background: !!m.background }
    })
    // c9 H5: work nobody waits on shows the first teammate's own find the moment they hand it on: one bubble, then the next one's (company-tools handoffShown).
    if (next?.background && !halting.has(leadChannel)) report?.(leadChannel, taskId)
    if (next) await runOne(taskId, leadChannel, next.to, signal, kit, budget)
  }

  // Members nobody waits for (assign with wait false). When the last of a task's has ended, its lead is told to report.
  async function later(taskId: string, leadChannel: string, ids: string[], kit: TurnKit): Promise<void> {
    laterKits.set(taskId, kit)
    told.delete(taskId)
    const share = Math.floor(Math.max(0, await tokensLeft(taskId)) / ids.length)
    const light = new Set(((await find(taskId))?.team?.members ?? []).filter(m => m.lookup || m.writer).map(m => m.id))
    // c5 (GROKBOT rule 7): the report waited for the slowest part however long it took. When the answer is due (taskDue, c13a) what has
    // come back is reported, the parts still at work are labeled there with the pages they have opened so far, and the report below, when
    // they end, is theirs alone. A part added since (a steer) moves the due time, so the timer reads it again when it fires.
    let cap: ReturnType<typeof setTimeout> | undefined
    const arm = async (): Promise<void> => {
      const task = await find(taskId)
      if (!task) return
      const wait = taskDue(task) - Date.now()
      if (wait > 0) { cap = setTimeout(() => void arm().catch(error => flog('team', error)), wait); return }
      const late = await change(taskId, t => {
        const ids = markLate(t)
        for (const m of t.team?.members ?? []) { const read = reading.get(`${taskId}/${m.id}`); if (ids.includes(m.id) && read?.size) m.sources = [...read] }
        return ids
      })
      if (late?.length && !halting.has(leadChannel) && !told.has(taskId)) report?.(leadChannel, taskId)
    }
    await arm()
    void Promise.all(ids.map(id => (light.has(id) ? inCallerSlot : asBackground)(() => chain(taskId, leadChannel, id, undefined, kit, share)))).finally(() => clearTimeout(cap)).then(async () => {
      const task = await find(taskId)
      if (task && !TERMINAL.includes(task.state) && !halting.has(leadChannel) && !backgroundOpen(task) && !told.has(taskId)) { told.add(taskId); report?.(leadChannel, taskId) }
    }).catch(error => flog('team', error))
  }

  async function orphan(taskId: string, id: string, ended: TeamMember['state'] | undefined): Promise<void> {
    const keys = await change(taskId, task => {
      const parent = task.team?.members.find(one => one.id === id), open = unreviewed(task.team, id)
      if (!open.length) return []
      const why = ended === 'failed' ? (parent?.result ?? 'it failed') : ended === 'done' ? 'it reached the token budget' : 'it was stopped'
      for (const m of open) { m.state = 'released'; m.finishedAt ??= now(); m.review = { ok: false, note: `Not reviewed: ${parent?.role ?? id} ended before reviewing it (${why.slice(0, 200)}).` } }
      if (parent && parent.state !== 'released') parent.result = `${parent.result ?? ''}\n\nNot reviewed by ${parent.role} (check before you accept): ${open.map(m => `${m.role}: ${(m.result ?? '(no result)').replace(/\s+/g, ' ')}`).join(' | ')}`.slice(0, MEMBER_RESULT_CHARS)
      return open.map(m => m.sessionKey)
    })
    for (const key of keys ?? []) deps.closeSession(key)
  }

  async function runMembers(taskId: string, leadChannel: string, callerLane: string, self: string | null, ids: string[], signal: AbortSignal | undefined, kit: TurnKit, redo?: MemberRedo): Promise<void> {
    const mark = (from: string, to: 'waiting' | 'reviewing') => self ? change(taskId, task => { const m = task.team?.members.find(one => one.id === self); if (m?.state === from) m.state = to }) : undefined
    await mark('working', 'waiting')
    waitingLanes.set(callerLane, (waitingLanes.get(callerLane) ?? 0) + 1)
    try {
      const share = Math.floor(Math.max(0, await tokensLeft(taskId)) / ids.length)
      // The caller's pool slot is given back for the whole wait; each child takes a root slot from the background line.
      // Lookup members are light and work side by side in the caller's slot: when all are, the caller keeps its slot for them.
      const light = new Set(((await find(taskId))?.team?.members ?? []).filter(m => (m.lookup || m.writer) && ids.includes(m.id)).map(m => m.id))
      const all = () => Promise.all(ids.map(id => (light.has(id) ? inCallerSlot : asBackground)(() => chain(taskId, leadChannel, id, signal, kit, share, redo))))
      await (light.size === ids.length ? all() : whileWaitingForPerson(all))
    } finally {
      const left = (waitingLanes.get(callerLane) ?? 1) - 1
      if (left) waitingLanes.set(callerLane, left); else waitingLanes.delete(callerLane)
      await mark('waiting', 'reviewing')
    }
  }

  async function settle(task: DelegatedTask): Promise<void> {
    if (!task.team) return
    for (const m of task.team.members) deps.closeSession(m.sessionKey)
    if (TERMINAL.includes(task.state)) { laterKits.delete(task.id); told.delete(task.id); if (task.team.members.some(m => m.state !== 'released')) await change(task.id, t => { if (t.team) releaseAll(t.team, now()) }); notes.delete(channelOf(task)) }
  }

  return {
    // The lead's engine for one turn: its tool session is known here, so members' tokens are charged to it.
    leadEngine(channel: string, engine: Engine): Engine {
      if (laneMember(channel) || !/^bot-[^~]+$/.test(channel) || !engine.runTools) return engine
      const runTools = async (job: ToolSessionJob) => {
        const lead = { job, spent: 0 }
        leads.set(channel, lead)
        try { return await engine.runTools!({ ...job, onUsage: tokens => { lead.spent += tokens; job.onUsage?.(tokens) } }) } finally { if (leads.get(channel) === lead) leads.delete(channel) }
      }
      return new Proxy(engine, { get: (target, prop) => { if (prop === 'runTools') return runTools; const value = Reflect.get(target, prop, target) as unknown; return typeof value === 'function' ? value.bind(target) : value } })
    },
    // staffChanged is given on the primary thread's own turn only: it alone may hand work to agents on the team (assign).
    tools(channel: string, kit: TurnKit, staffChanged?: () => void): AgentTool[] {
      const leadChannel = leadOf(channel), self = laneMember(channel)?.[2] ?? null
      if (!/^bot-[^~]+$/.test(leadChannel)) return []
      const load = async () => (await listTasks(paths)).find(t => t.state === 'running' && channelOf(t) === leadChannel)
      const host: TeamHost = {
        self, load,
        change: async work => { const task = await load(); return task ? change(task.id, work) : undefined },
        run: async (ids, signal, redo) => { const task = await load(); if (task) await runMembers(task.id, leadChannel, channel, self, ids, signal, kit, redo) },
        release: async ids => { const task = await load(); if (task) await release(task.id, ids) },
        live: id => [...live.keys()].some(key => key.endsWith(`/${id}`) && live.get(key)!.channel === leadChannel),
        tokensLeft: async () => { const task = await load(); return task ? tokensLeft(task.id) : 0 },
        personSaid: kit.said,
        ...(kit.alive ? { alive: kit.alive, due: async () => { const task = await load(); return task ? taskDue(task) : undefined } } : {}),
        ...(self === null && deps.steered ? { steered: (signal: AbortSignal) => deps.steered!(leadChannel, signal) } : {}),
      }
      if (!staffChanged || self !== null) return teamHireTools(host)
      return [...teamHireTools(host), assignTool(paths, {
        ...host,
        later: async ids => { const task = await load(); if (task) await later(task.id, leadChannel, ids, kit) },
        ...(kit.engine.id === 'claude' && kit.engine.quick ? { write: (prompt: string, ms = REPORT_WRITER_MS) => kit.engine.quick!(prompt, { workdir: kit.workdir, timeoutMs: ms }) } : {}),
        // The job that agent is on right now in this thread, whichever task of the thread it belongs to.
        attach: async (botId, then) => {
          for (const [key, one] of live) {
            if (one.channel !== leadChannel) continue
            const [taskId, id] = key.split('/') as [string, string]
            if (await change(taskId, task => { const m = task.team?.members.find(x => x.id === id); if (m?.botId !== botId || m.then || !['hired', 'working'].includes(m.state)) return false; m.then = then; return true })) return true
          }
          return false
        },
      }, staffChanged)]
    },
    // A member's approval is raised on the lead's task, with the member's role in front.
    askFor(channel: string, confirm: Ask, waitMs?: number): Ask | undefined {
      const lane = laneMember(channel)
      if (!lane) return deps.askFor(channel, confirm, waitMs)
      const [, leadChannel, id] = lane as unknown as [string, string, string]
      return (async what => {
        const task = (await listTasks(paths)).find(t => t.state === 'running' && channelOf(t) === leadChannel)
        const prefix = `${task?.team?.members.find(m => m.id === id)?.role ?? id}: `
        const ask = deps.askFor(leadChannel, own => confirm({ ...own, words: own.words.startsWith(prefix) ? own.words.slice(prefix.length) : own.words }), waitMs)
        return ask ? ask({ ...what, words: `${prefix}${what.words}` }) : 'cancel'
      }) as Ask
    },
    reportTo(tell: (channel: string, taskId: string) => void): void { report = tell },
    // c4b r2 (GROKBOT rule 3): words said while a task's background members work change that work. A part taken off is stopped and leaves
    // nothing; a part added starts beside the others, and the one report waits for it (later). False: nothing was changed.
    async steer(taskId: string, leadChannel: string, work: (task: DelegatedTask) => { ids: string[]; stop: string[] } | undefined): Promise<boolean> {
      const kit = laterKits.get(taskId)
      if (!kit) return false
      const out = await change(taskId, work)
      if (!out) return false
      if (out.ids.length) await later(taskId, leadChannel, out.ids, kit)
      for (const id of out.stop) live.get(`${taskId}/${id}`)?.control.abort()
      return true
    },
    waiting: (channel: string): boolean => waitingLanes.has(channel),
    note: (channel: string): string => notes.get(channel) ?? '',
    // The lead's answer with a link for every member whose pages it left out.
    async cited(channel: string, answer: string): Promise<string> {
      const task = (await listTasks(paths)).find(t => t.state === 'running' && channelOf(t) === channel)
      return task?.team ? citeMembers(answer, task.team.members, isKorean(task.goal)) : answer
    },
    async stop(channel: string): Promise<void> {
      halting.add(channel)
      try {
        for (const one of live.values()) if (one.channel === channel) one.control.abort()
        for (const task of (await listTasks(paths)).filter(t => channelOf(t) === channel && t.team?.members.some(m => m.state !== 'released'))) {
          for (const key of await change(task.id, t => t.team ? releaseAll(t.team, now()) : []) ?? []) deps.closeSession(key)
          screen.delete(task.id)
        }
        notes.delete(channel)
      } finally { halting.delete(channel) }
    },
    settled: settle,
    // Members left by a task that ended, or lost when their lead's turn ended, do not stay open.
    async turnEnded(channel: string): Promise<void> {
      for (const task of (await listTasks(paths)).filter(t => channelOf(t) === channel && t.team)) {
        if (TERMINAL.includes(task.state)) { if (task.team!.members.some(m => m.state !== 'released')) await settle(task); continue }
        // A background member is not this turn's: it ends by itself, by a stop, or by a restart.
        const lost = task.team!.members.filter(m => ['hired', 'working'].includes(m.state) && !m.background && !live.has(`${task.id}/${m.id}`))
        if (lost.length) await change(task.id, t => { for (const m of t.team?.members ?? []) if (lost.some(l => l.id === m.id) && ['hired', 'working'].includes(m.state)) { m.state = 'failed'; m.result = 'Failed: its lead\'s turn ended.'; m.finishedAt = now() } })
      }
    },
    async resume(): Promise<void> {
      for (const task of (await listTasks(paths)).filter(t => t.team)) {
        // stack-4 (c4b run, C3): this runs 15 s after launch, and a split handed out at 14.6 s had its three teammates closed 0.35 s into
        // their work ("이번엔 못 찾았어요" three times). Members at work in this run are not leftovers of the last one.
        if (laterKits.has(task.id) || task.team!.members.some(m => live.has(`${task.id}/${m.id}`))) continue
        for (const m of task.team!.members) deps.closeSession(m.sessionKey)
        await change(task.id, t => { if (!t.team) return; if (TERMINAL.includes(t.state)) releaseAll(t.team, now()); else failOnRestart(t.team, now()) })
        // A task that was waiting only for its background members has nobody left to wake it: its lead reports what there is, lost work included.
        if (task.state === 'waiting' && !task.question && task.team!.members.some(m => m.background)) report?.(channelOf(task), task.id)
      }
    },
  }
}
