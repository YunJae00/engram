import { ANSWER_NOW, backgroundOpen, failOnRestart, keepRead, timeBoxed, keepSources, LATE_CEILING_MS, listTasks, LOOKUP_MAX_CALLS, PRIOR_PRICE_NOTE, priorPriceQuery, figurePages, LOOKUP_TOOLS, MEMBER_BLOCKED, MEMBER_RESULT_CHARS, memberPersona, memberTask, releaseAll, runComet, SCREEN_TOOL, settleMember, skipWalls, TASK_TOKEN_BUDGET, TEAM_ANSWER_MS, teamHireTools, teamNote, unreviewed, updateTask, type AgentTool, type DelegatedTask, type Engine, type MemberOutcome, type MemberRedo, type TeamHost, type TeamMember, type ToolSessionJob, type VaultPaths } from 'core'
import type { Ask } from './page-actions.js'
import { asBackground, inCallerSlot, whileWaitingForPerson } from './worker-pool.js'
import { flog } from './flog.js'
import { answerOnly } from './result-check.js'
import { withFiles } from './native-tools.js'
import { isKorean } from './task-closing.js'
import { asides, turnGoals } from './turn-state.js'
import { assignTool, checkedSearch, setJudgeLog, handedData, employeeNote, employeeWriteBack, isSearchPage, firstFound, firstSearches, type FirstSearch, handoffBrief, jobTitle, lateParts, followsLate, logTask, partOutcome, makerFirst, markLate, REPORT_WRITER_MS, WRITER_RULE, writesFromHandover } from 'core'

export const WRITER_HARD_MS = 20_000
const OPENING_LINE_CHARS = 60
const LEAD_ANSWER_MS = 6_000
const MIN_PART_MS = TEAM_ANSWER_MS / 2
const SOFT_SHARE = 0.5
const RESERVE_SHARE = 0.25
const REPORT_ROUND_MS = 6_000
const EMPTY_RETRY_MS = 10_000
const noData = (m: TeamMember): boolean => m.data ? !m.data.facts.length && !m.data.nothing?.latest : m.state === 'failed' || !!m.empty || !m.result?.trim()
export const emptyRetryNote = (words: readonly string[], others: readonly string[]): string => [
  'Your part came back with nothing. What the person said for this work, a line each:', ...words.map(line => `- ${line.slice(0, 400)}`),
  ...(others.length ? [`The other parts: ${others.join(', ')}.`] : []),
  'Your part is the piece of their words your brief is about. Search for it again in their words: the place, thing or name exactly as the person wrote it, not as your brief or your last search spelled it.',
].join('\n')

type Deps = Parameters<typeof runComet>[0]
type Native = NonNullable<Parameters<typeof runComet>[2]>['native']
export const laneSearches = new Map<string, { query: string; found: string }>()
const sameWords = (a: string, b: string): boolean => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()
export const memberLane = (channel: string, id: string): string => `${channel}~team-${id}`
const laneMember = (lane: string): RegExpExecArray | null => /^(bot-[^~]+)~team-(m\d+)$/.exec(lane)
export const leadOf = (lane: string): string => laneMember(lane)?.[1] ?? lane

export interface TurnKit {
  engine: Deps['engine']; workdir: Deps['workdir']; guided: boolean; said(): string
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
  steered?(channel: string, signal: AbortSignal): Promise<void>
  busy?(channel: string): boolean
  run?: typeof runComet
  answerMs?: number
}) {
  const { paths } = deps
  const answerMs = deps.answerMs ?? TEAM_ANSWER_MS, scale = answerMs / TEAM_ANSWER_MS
  const taskDue = (task: DelegatedTask): number => Math.max(Date.parse(task.createdAt) + answerMs, ...(task.team?.members ?? []).filter(m => m.parentId === null && !!m.botId && m.background).map(m => Date.parse(m.hiredAt) + MIN_PART_MS * scale))
  const reading = new Map<string, Set<string>>()
  setJudgeLog(line => flog('item-judge', line))
  const live = new Map<string, { control: AbortController; channel: string }>()
  const waitingLanes = new Map<string, number>()
  const inflight = new Map<string, number>()
  const screen = new Map<string, string>()
  const notes = new Map<string, string>()
  const roles = new Map<string, string>()
  const halting = new Set<string>()
  const leads = new Map<string, { job: ToolSessionJob; spent: number }>()
  let report: ((channel: string, taskId: string) => void) | undefined
  const laterKits = new Map<string, TurnKit>()
  const told = new Set<string>()
  const charge = (leadChannel: string, tokens: number) => { const lead = leads.get(leadChannel); if (!lead) return false; lead.spent += tokens; lead.job.onUsage?.(tokens); return true }
  const channelOf = (task: DelegatedTask) => `bot-${task.botId}`
  const now = () => new Date().toISOString()
  const looked = new Map<string, { sources: string[]; kept: string[] }>()
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
    for (const id of ids) live.get(`${taskId}/${id}`)?.control.abort()
  }

  function screenGuard(tool: AgentTool, taskId: string, member: TeamMember): AgentTool {
    if (!SCREEN_TOOL.test(tool.name)) return tool
    const take = () => {
      const holder = screen.get(taskId)
      if (holder && holder !== member.id) throw new Error(`${roles.get(`${taskId}/${holder}`) ?? holder} is using the screen. Do the parts that need no screen, or report that the screen was busy.`)
      screen.set(taskId, member.id)
    }
    return { ...tool, run: async (args, context) => { take(); return tool.run(args, context) }, ...(tool.runRich ? { runRich: async (args, context) => { take(); return tool.runRich!(args, context) } } : {}) }
  }

  async function runOne(taskId: string, leadChannel: string, id: string, signal: AbortSignal | undefined, kit: TurnKit, budget: number, redo?: MemberRedo): Promise<boolean> {
    const key = `${taskId}/${id}`, lane = memberLane(leadChannel, id)
    const control = new AbortController(), stop = () => control.abort()
    if (signal?.aborted) control.abort(); else signal?.addEventListener('abort', stop, { once: true })
    live.set(key, { control, channel: leadChannel })
    let retry = false, used = 0, role = id, goal = '', due = Date.now() + answerMs, ended: TeamMember['state'] | undefined, done: { botId: string; brief: string; result: string; title?: string } | undefined
    let charged = leads.has(leadChannel)
    try {
      const member = await change(taskId, task => { const m = task.team?.members.find(one => one.id === id); goal = task.goal; due = taskDue(task); if (m?.state === 'hired' && (task.state === 'running' || (m.background && !TERMINAL.includes(task.state)))) { m.state = 'working'; return { me: structuredClone(m), helpers: redo ? structuredClone(unreviewed(task.team, id)) : [] } } return undefined })
      if (!member) return false
      const { me, helpers } = member
      role = me.role; roles.set(key, role)
      if (me.background) charged = false
      const persona = memberPersona(me) + (me.botId ? await employeeNote(paths, me.botId, undefined, me.writer ? 'writer' : me.lookup ? 'lookup' : undefined) : '') + (me.writer ? ` ${WRITER_RULE}` : '')
      let outcome: MemberOutcome
      let timedOut = false, draft = '', read = false, hardStop: ReturnType<typeof setTimeout> | undefined, whole: MemberOutcome | undefined
      const sources = new Set<string>(), kept: string[] = []
      const before = redo && looked.get(key)
      if (before) { looked.delete(key); for (const url of before.sources) sources.add(url); kept.push(...before.kept) }
      reading.set(key, sources)
      let startedAt: number | undefined, stopAt = Infinity, reserveMs = 0
      const toolRound = new AbortController()
      control.signal.addEventListener('abort', () => toolRound.abort(), { once: true })
      if (!me.botId) due -= LEAD_ANSWER_MS * scale
      let answering = false, reserve: ReturnType<typeof setTimeout> | undefined
      const readSome = (): boolean => kept.length > 0 || [...sources].some(url => !isSearchPage(url))
      const answerNow = () => {
        if (control.signal.aborted || !readSome()) return
        if (/```|^\s*\{/.test(draft)) return
        answering = true; toolRound.abort()
      }
      const cut = (): void => { timedOut = true; control.abort() }
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
        if (!redo) due = Math.max(due, startedAt + MIN_PART_MS * scale)
        stopAt = due
        const window = due - startedAt
        reserveMs = Math.min(window, Math.max(REPORT_ROUND_MS * scale, window * RESERVE_SHARE))
        hardStop = setTimeout(() => void atDue(), window)
        if (me.botId) reserve = setTimeout(answerNow, window - reserveMs)
      }
      const left = (): number => (due - Date.now()) / scale
      const quick = kit.engine.id === 'claude' && kit.engine.quick ? (prompt: string, ms = REPORT_WRITER_MS) => kit.engine.quick!(prompt, { workdir: kit.workdir, timeoutMs: ms }) : undefined
      let opener: AgentTool | undefined
      const helperJudged = (tool: AgentTool): AgentTool => tool.name === 'search_web' && me.lookup ? checkedSearch(tool, {
        ask: () => me.brief, ...(quick ? { write: quick } : {}), due: () => due - reserveMs,
        ...(opener ? { read: (url: string, signal?: AbortSignal) => opener!.run({ url }, { task: me.brief, ...(signal ? { signal } : {}) }) } : {}),
      }) : tool
      const soft = (): number => { const from = startedAt ?? Date.now(); return Math.max(0, (Math.max(due, from + MIN_PART_MS * scale) - from) * SOFT_SHARE) }
      let tools: AgentTool[] = []
      const drafted = { onToken: (text: string) => { begun(); draft += text }, onReset: () => { draft = '' } }
      try {
        const native = me.lookup || me.writer ? undefined : await kit.nativeFor(lane)
        const menu = me.writer ? [] : (await kit.toolsFor(lane, native)).filter(tool => !MEMBER_BLOCKED.test(tool.name) && (!me.lookup || LOOKUP_TOOLS.has(tool.name)))
        const open = menu.find(tool => tool.name === 'open_page')
        if (open) opener = keepRead(keepSources(skipWalls(open), sources), kept)
        const boxed = (tool: AgentTool): AgentTool => timeBoxed(keepRead(keepSources(skipWalls(helperJudged(tool)), sources), kept), left)
        tools = menu.map(tool => screenGuard(me.lookup ? boxed(tool) : tool, taskId, me))
        let prompt = memberTask(me, goal, redo, helpers)
        const search = me.lookup && me.query && !redo ? tools.find(tool => tool.name === 'search_web') : undefined
        if (search) {
          begun()
          const held = laneSearches.get(leadChannel), task = prompt
          const founds: (FirstSearch & { found: string; own?: boolean })[] = []
          for (const one of firstSearches(me, goal)) {
            const already = held && sameWords(held.query, one.query) ? held.found : undefined, args = { query: one.query, ...(one.news ? { kind: 'news' } : {}) }
            const raw = menu.find(tool => tool.name === 'search_web')!, found = await (already !== undefined ? boxed({ ...raw, run: async () => already }) : search).run(args, { task, signal: control.signal }).catch(() => '')
            if (/^results for "/.test(found)) founds.push({ ...one, ...(one.maker ? makerFirst(found, one.maker) : { found }) })
          }
          if (founds.length) { read = true; prompt += firstFound(founds) }
        }
        let priced = false
        for (let round = 0; ; round++) {
          const stepAt = Date.now()
          const result = await (deps.run ?? runComet)({ engine: kit.engine, workdir: kit.workdir, tools }, prompt, {
            signal: toolRound.signal, persona, session: me.sessionKey, guided: kit.guided, tokenBudget: Math.max(0, budget - used),
            onStart: begun,
            onUsage: tokens => { begun(); used += tokens; if (!(charged && charge(leadChannel, tokens))) inflight.set(taskId, (inflight.get(taskId) ?? 0) + tokens) },
            ...(native ? { native } : {}),
            waitingForPerson: () => waitingLanes.has(lane) || deps.waitingForPerson(leadChannel),
            onStep: line => { read = true; deps.step(leadChannel, line) },
            ...(me.lookup ? { modelHint: 'smart' as const, lookup: true, maxCalls: LOOKUP_MAX_CALLS, deadlineMs: soft(), ...drafted } : me.writer ? { modelHint: 'smart' as const, ...drafted } : {}),
          })
          if (!round && me.lookup) flog('team', `first-step role=${role} ms=${Date.now() - stepAt} pages=${(prompt.match(/^The page at /gm) ?? []).length} answered=${!!result.answer.trim()}`)
          const cutShort = !!me.lookup && result.stopped === 'calls' && !result.asked
          outcome = { answer: withFiles(cutShort ? answerOnly(result.answer) : result.answer, result.files), ...(result.asked ? { asked: true } : {}), ...(result.budgetExhausted ? { budgetExhausted: true } : {}), ...(cutShort ? { timedOut: true } : {}) }
          whole = undefined
          const prior = !priced && search && !result.asked && !result.budgetExhausted && !control.signal.aborted ? priorPriceQuery(me, outcome.answer) : ''
          if (prior && search) {
            priced = true
            const found = await search.run({ query: prior }, { task: prompt, signal: control.signal }).catch(() => '')
            if (/^results for "/.test(found)) { whole = outcome; draft = ''; prompt = `${PRIOR_PRICE_NOTE}\n${found}`; round--; continue }
          }
          const open = unreviewed((await find(taskId))?.team, id)
          if (!open.length || result.asked || result.budgetExhausted || toolRound.signal.aborted) break
          if (round) { outcome = { answer: '', error: `it reported without reviewing ${open.map(m => m.role).join(', ')}.` }; break }
          prompt = reviewFirst(open)
        }
      } catch (error) { outcome = { answer: '', error: error instanceof Error ? error.message : String(error) } }
      const turn = (task: string, roundTools: AgentTool[]) => (deps.run ?? runComet)({ engine: kit.engine, workdir: kit.workdir, tools: roundTools }, task, {
        signal: control.signal, persona, session: me.sessionKey, guided: kit.guided, tokenBudget: Math.max(0, budget - used), modelHint: 'smart' as const, ...drafted,
        ...(me.lookup ? { light: true } : {}),
        onUsage: tokens => { used += tokens; if (!(charged && charge(leadChannel, tokens))) inflight.set(taskId, (inflight.get(taskId) ?? 0) + tokens) },
      })
      if (answering && !control.signal.aborted) {
        draft = ''
        try { outcome = { answer: (await turn(`${ANSWER_NOW} Write it as the report block your rules describe. What you read:\n${kept.join('\n\n').slice(0, 6000)}`, [])).answer } } catch { outcome = { answer: '' } }
      }
      clearTimeout(reserve)
      const opening = !!me.lookup && !read && !draft.trim().includes('\n') && draft.trim().length <= OPENING_LINE_CHARS
      if (timedOut && !signal?.aborted) outcome = whole ?? { answer: opening ? '' : draft, timedOut: true }
      else if (control.signal.aborted) outcome = { answer: '', error: 'it was stopped.' }
      clearTimeout(hardStop)
      reading.delete(key)
      const report = !!me.botId && (!!me.lookup || !!me.writer) && !outcome.error && !outcome.asked ? handedData(outcome.answer, me, [...sources], isKorean(goal)) : undefined
      await change(taskId, task => {
        if (!charged) task.tokensUsed = (task.tokensUsed ?? 0) + used
        const m = task.team?.members.find(one => one.id === id)
        if (me.lookup && !me.botId && outcome.answer && kept.length) outcome = { ...outcome, answer: figurePages(outcome.answer, kept.join('\n')) }
        if (m && m.state !== 'released' && !(control.signal.aborted && !timedOut && halting.has(leadChannel))) {
          settleMember(m, { ...outcome, ...(sources.size ? { sources: [...sources] } : {}), ...(kept.length ? { read: [...new Set(kept)].join('\n\n') } : {}), ...(report ? { report } : {}) }, now(), isKorean(goal))
          if (me.lookup && !me.botId) m.shown = [...new Set([...sources, ...kept.flatMap(text => text.match(/https?:\/\/[^\s)\]>"'|]+/g) ?? [])])]
          if (!redo && me.lookup && !outcome.error && !control.signal.aborted && !halting.has(leadChannel) && (m.state === 'done' || m.state === 'failed') && noData(m) && due - Date.now() >= EMPTY_RETRY_MS * scale) {
            for (const field of ['result', 'sources', 'read', 'empty', 'unfinished', 'data', 'review', 'finishedAt', 'shown'] as const) delete m[field]
            m.state = 'hired'; retry = true
            looked.set(key, { sources: [...sources], kept: [...kept] })
          }
        }
        ended = m?.state
        if (m?.botId && (ended === 'done' || (ended === 'failed' && (timedOut || !control.signal.aborted)))) done = { botId: m.botId, brief: m.brief, result: ended === 'done' && !m.empty && partOutcome(m) !== 'unfinished' ? m.result ?? '' : '', ...(m.title ? { title: m.title } : {}), ...(ended === 'done' && m.data ? { data: m.data } : {}) }
      })
      if (done) {
        const busy = () => deps.busy?.(`bot-${done!.botId}`) ?? false, wrote = employeeWriteBack(paths, done, undefined, busy).catch(error => flog('team', error))
        if (!busy()) await wrote
      }
    } catch (error) { flog('team', error) } finally {
      signal?.removeEventListener('abort', stop)
      live.delete(key)
      if (!charged) { const left = (inflight.get(taskId) ?? 0) - used; if (left > 0) inflight.set(taskId, left); else inflight.delete(taskId) }
      if (screen.get(taskId) === id) screen.delete(taskId)
      if (ended !== 'waiting' && !halting.has(leadChannel)) await orphan(taskId, id, ended).catch(error => flog('team', error))
      deps.endLane(lane)
      if (!retry) deps.step(leadChannel, isKorean(goal) ? `${role} 끝` : `${role} finished`)
    }
    return retry
  }

  async function chain(taskId: string, leadChannel: string, id: string, signal: AbortSignal | undefined, kit: TurnKit, budget: number, redo?: MemberRedo): Promise<void> {
    if (await runOne(taskId, leadChannel, id, signal, kit, budget, redo) && !signal?.aborted && !halting.has(leadChannel)) {
      const task = await find(taskId), others = (task?.team?.members ?? []).filter(m => m.id !== id && m.lookup).map(m => m.role)
      const words = [...new Set([turnGoals.get(leadChannel) || task?.goal || '', ...(asides.get(leadChannel) ?? []).filter(one => one.role === 'user').map(one => one.text)].map(line => line.trim()).filter(Boolean))]
      await runOne(taskId, leadChannel, id, signal, kit, budget, { note: emptyRetryNote(words, others) })
    } else if (redo) return
    const next = await change(taskId, task => {
      const team = task.team, m = team?.members.find(one => one.id === id)
      if (!team || !m?.then || m.state !== 'done' || team.hires >= team.maxHires) return undefined
      const to = `m${team.members.length + 1}`
      team.members.push({ id: to, parentId: m.parentId, depth: m.depth, role: m.then.who, brief: handoffBrief(m.then.brief, m.role, m.result ?? '', m.brief), botId: m.then.botId, ...(m.then.voice ? { voice: m.then.voice } : {}), title: jobTitle(m.then.brief), ...(writesFromHandover(m.then.brief) ? { writer: true as const } : { lookup: true }), ...(m.background ? { background: true as const } : {}), ...(m.late ? { late: true as const } : {}), state: 'hired', sessionKey: `team-${task.id}-${to}`, hiredAt: now() })
      team.hires++
      logTask(task, `${m.role} handed over to ${m.then.who}`)
      return { to, background: !!m.background }
    })
    if (next?.background && !halting.has(leadChannel)) report?.(leadChannel, taskId)
    if (next) await runOne(taskId, leadChannel, next.to, signal, kit, budget)
  }

  async function later(taskId: string, leadChannel: string, ids: string[], kit: TurnKit): Promise<void> {
    laterKits.set(taskId, kit)
    told.delete(taskId)
    const share = Math.floor(Math.max(0, await tokensLeft(taskId)) / ids.length)
    const light = new Set(((await find(taskId))?.team?.members ?? []).filter(m => m.lookup || m.writer).map(m => m.id))
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
    leadEngine(channel: string, engine: Engine): Engine {
      if (laneMember(channel) || !/^bot-[^~]+$/.test(channel) || !engine.runTools) return engine
      const runTools = async (job: ToolSessionJob) => {
        const lead = { job, spent: 0 }
        leads.set(channel, lead)
        try { return await engine.runTools!({ ...job, onUsage: tokens => { lead.spent += tokens; job.onUsage?.(tokens) } }) } finally { if (leads.get(channel) === lead) leads.delete(channel) }
      }
      return new Proxy(engine, { get: (target, prop) => { if (prop === 'runTools') return runTools; const value = Reflect.get(target, prop, target) as unknown; return typeof value === 'function' ? value.bind(target) : value } })
    },
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
        ...(self === null && deps.steered ? { steered: (signal: AbortSignal) => deps.steered!(leadChannel, signal) } : {}),
      }
      if (!staffChanged || self !== null) return teamHireTools(host)
      return [...teamHireTools(host), assignTool(paths, {
        ...host,
        later: async ids => { const task = await load(); if (task) await later(task.id, leadChannel, ids, kit) },
        ...(kit.engine.id === 'claude' && kit.engine.quick ? { write: (prompt: string, ms = REPORT_WRITER_MS) => kit.engine.quick!(prompt, { workdir: kit.workdir, timeoutMs: ms }) } : {}),
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
    async turnEnded(channel: string): Promise<void> {
      for (const task of (await listTasks(paths)).filter(t => channelOf(t) === channel && t.team)) {
        if (TERMINAL.includes(task.state)) { if (task.team!.members.some(m => m.state !== 'released')) await settle(task); continue }
        const lost = task.team!.members.filter(m => ['hired', 'working'].includes(m.state) && !m.background && !live.has(`${task.id}/${m.id}`))
        if (lost.length) await change(task.id, t => { for (const m of t.team?.members ?? []) if (lost.some(l => l.id === m.id) && ['hired', 'working'].includes(m.state)) { m.state = 'failed'; m.result = 'Failed: its lead\'s turn ended.'; m.finishedAt = now() } })
      }
    },
    async resume(): Promise<void> {
      for (const task of (await listTasks(paths)).filter(t => t.team)) {
        if (laterKits.has(task.id) || task.team!.members.some(m => live.has(`${task.id}/${m.id}`))) continue
        for (const m of task.team!.members) deps.closeSession(m.sessionKey)
        await change(task.id, t => { if (!t.team) return; if (TERMINAL.includes(t.state)) releaseAll(t.team, now()); else failOnRestart(t.team, now()) })
        if (task.state === 'waiting' && !task.question && task.team!.members.some(m => m.background)) report?.(channelOf(task), task.id)
      }
    },
  }
}
