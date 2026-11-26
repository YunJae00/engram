import { outputCards, finalDesktopFailure } from './agent-session-result.js'
import { collectionProgress } from './collection-progress.js'
import type { ToolSessionJob, ToolSessionResult } from './engine/types.js'
import type { AgentLoopDeps, AgentLoopOptions, AgentLoopResult, AgentLoopStep } from './agent-loop.js'
import { withinBudget, toolBudgetMs, ToolOverBudget } from './tool-budget.js'
import { sessionMenu } from './session-menu.js'
import { runAgentLoop, said } from './agent-loop.js'
import { conversationLines, personaLines, resumeLines, skillIndexLines } from './agent-prompt.js'
import { ONE_BUBBLE_RULE } from './agent-voice.js'
import { parseAsk } from './ask.js'
import { DESKTOP_TOOL_ISOLATION_MESSAGE, type ToolSessionCall } from './engine/types.js'
import { EARLIER_REPLIES_RULE, sessionRules } from './agent-session-shape.js'
import { withoutSecrets } from './secrets.js'
import { answerLanguageLine } from './task-proposal.js'
import { desktopScopeTools, desktopStepArgs, desktopStepSummary, isDesktopTool } from './desktop-tools.js'
import { taskPlan } from './agent-plan.js'
import { officeWriteUnverified } from './office-verification.js'
import { officeArithmeticFault } from './office-arithmetic.js'
import { evidenceFault } from './work-evidence.js'
import { pageDelta } from './page-delta.js'
import { TASK_TOKEN_BUDGET } from './delegated-tasks.js'


export const SESSION_MAX_CALLS = 120
const CALL_CEILING = 300
const REPEAT_GUARDED = new Set(['press', 'type_text', 'choose', 'press_point', 'page_steps', 'hover', 'reveal'])
const RECEIPT_ACTIONS = new Set(['press', 'press_point', 'press_key', 'type_text', 'choose', 'page_steps', 'page_do', 'page_each', 'upload_file'])
const PAGE_MOVES = new Set([...REPEAT_GUARDED, 'press_key', 'scroll', 'open_page', 'search_web', 'read_pages'])
export const PLAN_RULE = 'Plan mode: read and investigate only. Do not run commands, create or change files, or submit anything; reply with a concrete plan of what you would do and what you need from the person.'
const CONTENT_TOOLS = new Set(['read_pages', 'file_read', 'file_read_package', 'file_read_workbook', 'read_live_document', 'edit_live_document', 'compose_live_document', 'search_memory', 'read_note', 'open_page', 'read_open_page', 'search_web', 'press', 'type_text', 'choose', 'page_steps', 'scroll', 'hover', 'press_key', 'press_point', 'reveal', 'look', 'page_each', 'look_in_parallel'])

function readSoFar(steps: AgentLoopStep[], history?: AgentLoopOptions['history']): string {
  return [...said(history), ...steps.filter((step) => CONTENT_TOOLS.has(step.tool)).map((step) => step.observation)].join('\n')
}

function summarizeArgs(args: Record<string, unknown>): string {
  const first = Object.values(args).find((value) => typeof value === 'string' && value.trim())
  return typeof first === 'string' ? first.slice(0, 80) : ''
}

export function withSteer(text: string, said: string[]): string {
  if (!said.length) return text
  return `${text ? `${text}\n\n` : ''}The person just wrote, while you work: ${said.map(line => JSON.stringify(line)).join(', then ')}. First answer them in one short line in their language - that you got it, or the answer if they asked something - then go on, taking it into account; if it changes or stops the job, do that.`
}

export const ANSWER_NOW = 'Call no more tools. Answer now from what you already have, in the person\'s language: what you found, each fact with the address it came from, and in one plain clause what is not out yet or could not be found. Do not mention time, limits, turns, attempts or tools, do not apologize, and do not ask whether to try again or look further.'

const CLOSE_GRACE_MS = 150
const CLOSE_TAIL_MS = 15_000
const LATE_STEER_ROUNDS = 3
const RECHECK_CALLS = 2
const recheckNote = (draft: string, gap: string): string => `You had just written this answer; the person has not been given it:\n${draft.trim()}\n\n${gap} Fix only that: search once more in other words or open the articles (read_pages), then write ONE answer that replaces this one and keeps what holds. If it still falls short, list what you found and do not write how many: a line with that count is put under your answer.`
const UNSAID_NOTE = 'You did your last step but wrote no answer after it; the words before it were notes and the person has not seen them. Call no more tools. Write your answer to the person now from what you already have, in their language.'
const theirLanguage = (text: string, task: string): boolean => !/[가-힣]/.test(task) || /[가-힣]/.test(text) && !(text.match(/[A-Za-z]+/g) ?? []).some(word => !task.toLowerCase().includes(word.toLowerCase()))
function lateSteer(draft: string, said: string[]): string {
  return withSteer(`You had just written this answer; the person has not been given it as final:\n${draft.trim()}\n\nWrite ONE answer that replaces it: keep what still holds without redoing that work, do only the extra work their words need, and leave out what they replaced.`, said)
}

export async function runToolSession(deps: AgentLoopDeps, task: string, options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
  const desktop = deps.tools.some((tool) => isDesktopTool(tool.name))
  const files = deps.tools.some((tool) => tool.name.startsWith('file_'))
  const workflow = desktop || files
  const browser = !options.lookup && !options.short && deps.tools.some(tool => tool.name === 'open_page')
  const planned = workflow || browser
  const kind = options.lookup ? 'lookup' as const : options.short ? 'short' as const : 'work' as const
  const baseCalls = browser ? 120 : SESSION_MAX_CALLS
  if (workflow && deps.engine.desktopToolIsolation !== true) throw new Error(DESKTOP_TOOL_ISOLATION_MESSAGE)
  deps = { ...deps, tools: sessionMenu(desktopScopeTools(deps.tools)) }
  const runTools = deps.engine.runTools
  if (!runTools) throw new Error('this brain has no tool session')
  const steps: AgentLoopStep[] = []
  let liveSteer: ((said: string[]) => Promise<boolean>) | null = null
  const unread: string[] = []
  const takeSteer = (): string[] => [...unread.splice(0), ...(options.takeSteer?.() ?? [])]
  let nudge: (() => void) | undefined
  const ready = (): void => { const go = nudge; nudge = undefined; go?.() }
  const compactPage = pageDelta()
  const plan = taskPlan(steps)
  const collection = collectionProgress(steps)
  const tools = [...deps.tools, ...(browser ? [collection.tool] : []), ...(planned && desktop ? [plan.tool] : [])]
  const allowance = () => Math.min(options.maxCalls ?? 120, 120, baseCalls + plan.completed() * 20)
  const started = Date.now()
  let working = started
  const lifetime = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal
  let tokensUsed = 0, budgetExhausted = false
  let budgetWarning: string | undefined
  let budgetWarned = false
  const tokenBudget = options.tokenBudget ?? TASK_TOKEN_BUDGET
  const budgetNote = `The task token budget (${tokenBudget.toLocaleString('en-US')} new tokens available for this turn) was reached.`
  let startedCalls = 0
  let queued = 0
  const running = new Set<{ name: string; at: number; native: boolean; step?: AgentLoopStep }>()
  let unfinishedCalls = false
  let deciding = 0
  const waitingForPerson = () => deciding > 0 || options.waitingForPerson?.() === true
  let toolTail = Promise.resolve()
  let asked: { question: string; options: string[] } | null = null
  let carded = false
  let exhausted = false
  let extended = false
  let toolMs = 0
  let renewed = false
  const renew = (): void => { if (!options.lookup || renewed) return; renewed = true; exhausted = false; extended = false; startedCalls = 0; working = Date.now() }
  let stalled = false, stallNote = ''
  let closed: string | undefined, composing = false, close: ((result: ToolSessionResult) => void) | undefined
  const closeLines: string[] = []
  let held: (() => void)[] | undefined
  const release = (): void => { const kept = held; held = undefined; for (const show of kept ?? []) show() }
  let pageStepCalls = 0
  const decisionAvailable = deps.tools.some(tool => tool.name === 'page_do' || tool.name === 'app_do')
  const calls: ToolSessionCall[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    argsSchema: tool.argsSchema,
    run: async (args) => {
      signal.throwIfAborted()
      if (asked) return 'The question is already with the person. Reply with that question and nothing else.'
      if (carded) return 'A card is already with the person. End your answer now, in one line.'
      if (closed !== undefined) return 'The turn already ended with your last reply to the person. Call nothing more.'
      const closing = typeof tool.closes === 'function' ? tool.closes(args) : tool.closes === true
      if (!closing) { composing = true; release() }
      const late = options.deadlineMs !== undefined && Date.now() - working > options.deadlineMs
      if (options.lookup && !renewed && (late || startedCalls + 1 > allowance())) {
        const waiting = takeSteer()
        if (waiting.length) { renew(); return withSteer('That call was not run.', waiting) }
      }
      if (late) {
        exhausted = true
        return ANSWER_NOW
      }
      const budget = allowance()
      const cost = tool.name === 'read_pages' && Array.isArray(args['pages']) ? Math.min(4, Math.max(1, args['pages'].length)) : 1
      const checkpoint = !exhausted && tool.name === 'task_plan' && startedCalls === budget && budget < Math.min(options.maxCalls ?? 120, 120)
        && Object.keys(args).length === 2 && typeof args['finding'] === 'string' && args['evidenceStep'] === steps.length
      const finding = browser && budget >= baseCalls && startedCalls + cost <= (options.maxCalls ?? CALL_CEILING)
      if (startedCalls + cost > budget && finding) extended = true
      if (startedCalls + cost > budget && !checkpoint && !finding) {
        exhausted = true
        return options.lookup ? ANSWER_NOW : 'No more calls. Report incomplete work and the last confirmed state, in the person\'s language and without speaking of turns, limits or attempts; do not claim completion or propose saving this as a successful routine.'
      }
      if (PAGE_MOVES.has(tool.name) || RECEIPT_ACTIONS.has(tool.name)) collection.invalidate()
      startedCalls += cost
      if (decisionAvailable && tool.name === 'page_steps' && ++pageStepCalls === 3) options.onMetric?.({ kind: 'host', operation: 'decision-bypass', completed: pageStepCalls, requested: 3 })
      options.onStep?.(`${tool.name}: ${desktopStepSummary(tool.name, args) ?? summarizeArgs(args)}`)
      let observation: string
      let modelObservation: string | undefined
      let image: { data: string; mimeType: string } | undefined
      let observedAfterAction = false, committed = false
      let committedStep: AgentLoopStep | undefined
      const toolStarted = performance.now()
      try {
        const context = { task, steps: steps.slice(), read: readSoFar(steps, options.history), signal, onCommitted: () => {
          committed = true
          if (!committedStep) {
            committedStep = { tool: tool.name, args: desktopStepArgs(tool.name, args), observation: 'that did not work: Dispatched; completion is unconfirmed. Do not repeat this action.', committed: true }
            steps.push(committedStep)
          }
        } }
        if (tool.runRich) {
          const outcome = await withinBudget(tool.name, signal, own => tool.runRich!(args, { ...context, signal: own }), waitingForPerson)
          observation = outcome.text
          image = outcome.image
          modelObservation = compactPage(options.compactObservations === false || kind !== 'work' ? undefined : outcome.page)
          observedAfterAction = outcome.observedAfterAction === true
          committed ||= outcome.committed === true
        } else observation = await withinBudget(tool.name, signal, own => tool.run(args, { ...context, signal: own }), waitingForPerson)
      } catch (err) {
        if (signal.aborted) throw err
        observation = `that did not work: ${err instanceof Error ? err.message : String(err)}`
      }
      if (!modelObservation) compactPage()
      const duration = performance.now() - toolStarted
      toolMs += duration
      options.onMetric?.({ kind: 'tool', operation: tool.name, ms: Math.round(duration) })
      options.onMetric?.({ kind: 'observation', fullChars: observation.length, sentChars: (modelObservation ?? observation).length })
      signal.throwIfAborted()
      options.onObservation?.(tool.name, observation)
      const completedStep = { tool: tool.name, args: desktopStepArgs(tool.name, args), observation, ...(observedAfterAction ? { observedAfterAction: true } : {}), ...(committed ? { committed: true } : {}) }
      if (committedStep) Object.assign(committedStep, completedStep)
      else steps.push(completedStep)
      if ((tool.name === 'offer_study' || tool.name === 'study_findings') && !/^that did not work|^Nothing is being studied/.test(observation)) carded = true
      const ask = parseAsk(observation)
      if (ask) {
        asked = ask
        return 'The question is with the person. Reply with exactly that question and nothing else.'
      }
      const warning = budgetWarning
      budgetWarning = undefined
      const notes = [
        ...(warning ? [warning] : []),
        ...(collection.pending() ? [collection.pending()!] : []),
        ...(planned ? [`Observation step ${steps.length}`, ...(plan.pending() ? [plan.pending()!] : [])] : []),
      ]
      const delivered = modelObservation ?? observation
      const result = notes.length ? `${delivered}\n(${notes.join('; ')})` : delivered
      const said = takeSteer()
      if (said.length) renew()
      if (closing && !composing && !said.length && !observation.startsWith('that did not work')) {
        closeLines.push(observation)
        held ??= []
        const mark = startedCalls
        setTimeout(() => { if (startedCalls === mark && queued === 0 && !composing && !asked && !signal.aborted) { closed = closeLines.join('\n'); close?.({ answer: closed }) } }, CLOSE_GRACE_MS)
      } else release()
      const text = said.length && liveSteer && await liveSteer(said).catch(() => false) ? result : withSteer(result, said)
      return image ? { text, image } : text
    },
  }))
  const sessionCalls = calls.map((call): ToolSessionCall => ({ ...call, run: (args) => {
    queued++
    const run = async () => {
      signal.throwIfAborted()
      const active = { name: call.name, at: Date.now(), native: false }
      running.add(active)
      try { return await call.run(args) } finally { running.delete(active) }
    }
    const outcome = planned ? toolTail.then(run) : run()
    const settled = outcome.finally(() => { queued = Math.max(0, queued - 1); if (!queued) ready() })
    if (planned) toolTail = settled.then(() => undefined, () => undefined)
    return settled
  } }))
  const opening = conversationLines(options.history).join('\n')
  let checkedAt = Date.now()
  const watchdog = setInterval(() => {
    const elapsed = Date.now() - checkedAt
    checkedAt = Date.now()
    if (waitingForPerson()) {
      for (const call of running) call.at += elapsed
      return
    }
    const overdue = [...running].find(call => {
      const budget = toolBudgetMs(call.name)
      return budget !== null && Date.now() - call.at > budget
    })
    if (overdue) {
      stalled = true
      stallNote = new ToolOverBudget(overdue.name, toolBudgetMs(overdue.name)!).message
      lifetime.abort(new Error(stallNote))
    }
  }, 5_000)
  const job: ToolSessionJob = {
    onUsage: tokens => {
      if (!Number.isSafeInteger(tokens) || tokens <= 0) return
      tokensUsed += tokens
      options.onUsage?.(tokens)
      if (!budgetWarned && tokensUsed >= tokenBudget * 0.8 && tokensUsed < tokenBudget) {
        budgetWarned = true
        const warning = `Token budget nearly exhausted (${tokenBudget - tokensUsed} new tokens remaining). Stop exploring, report what you have with report_result_check if offered (fail/unknown where unverified) or collect_results partial/blocked, and finish.`
        budgetWarning = warning
        if (liveSteer) {
          budgetWarning = undefined
          void liveSteer([warning]).then(delivered => { if (!delivered) budgetWarning = warning }).catch(() => { budgetWarning = warning })
        }
      }
      if (tokensUsed >= tokenBudget) {
        budgetExhausted = true
        lifetime.abort(new Error(budgetNote))
      }
    },
    workdir: deps.workdir,
    system: sessionRules({ engineId: deps.engine.id, desktop, workflow, browser, planned, pageSteps: deps.tools.some(tool => tool.name === 'page_steps'), pageDo: deps.tools.some(tool => tool.name === 'page_do'), native: options.native, kind, tools: deps.tools.map(tool => tool.name) }),
    prompt: [...personaLines(options.persona, options.memory), ...(options.onScreen ? [options.onScreen] : []),
      ...(options.attachmentContext ? [options.attachmentContext] : []),
      ...resumeLines(options.resume),
      ...(desktop ? ['Prior-turn desktop observations are historical: use app_read for background accessibility work, or read_desktop/look_desktop for foreground work, before the first input this turn, then reuse fresh returned observations within this turn.'] : []),
      ...skillIndexLines(options.skills),
      ...(kind === 'work' ? [EARLIER_REPLIES_RULE] : []), `Task: ${task}`, answerLanguageLine(task), ONE_BUBBLE_RULE].join('\n'),
    ...(opening ? { opening } : {}),
    ...(options.session ? { sessionKey: options.session } : {}),
    ...(options.modelHint ? { modelHint: options.modelHint } : {}),
    ...(options.lookup || options.light ? { effort: 'low' as const } : {}),
    ...(options.native ? { native: {
      ...options.native,
      decide: async (name, input, signal) => {
        queued++; deciding++
        try { return await options.native!.decide(name, input, signal) } finally { deciding--; queued = Math.max(0, queued - 1); if (!queued) ready() }
      },
      onCall: (name, input) => {
        if (signal.aborted) return
        const step: AgentLoopStep | undefined = ['Bash', 'PowerShell', 'Shell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)
          ? { tool: name, args: { ...input }, observation: 'that did not work: Dispatched; completion is unconfirmed. Do not repeat this action.', committed: true } : undefined
        if (step) steps.push(step)
        running.add({ name, at: Date.now(), native: true, step }); queued++
        options.native!.onCall?.(name, input)
      },
      onResult: (name, ok) => {
        const active = [...running].find(call => call.native && call.name === name)
        if (!active) return
        if (active.step) active.step.observation = ok ? 'Native action completed.' : 'that did not work: Native action did not report success; it may have partly happened. Inspect the current state and do not repeat it.'
        running.delete(active); queued = Math.max(0, queued - 1); if (!queued) ready(); options.native!.onResult?.(name, ok)
      },
    } } : {}),
    tools: sessionCalls,
    onContextReset: () => { compactPage() },
    onStart: () => { working = Date.now(); options.onStart?.() },
    maxCalls: options.maxCalls ?? (browser ? CALL_CEILING : planned ? 120 : SESSION_MAX_CALLS),
    onToken: (text: string) => { if (!text || closed !== undefined) return; if (held) held.push(() => options.onToken?.(text)); else options.onToken?.(text) },
    onSteerable: (steer) => { liveSteer = steer; if (steer) ready(); options.onSteerable?.(steer) },
    ...(options.onReset ? { onReset: (...args: Parameters<NonNullable<typeof options.onReset>>) => { if (closed !== undefined) return; if (held) held.push(() => options.onReset!(...args)); else options.onReset!(...args) } } : {}),
    signal,
  }
  let session: ToolSessionResult
  let end!: () => void
  const ended = new Promise<ToolSessionResult>(resolve => {
    end = () => resolve({ answer: '' })
    signal.addEventListener('abort', end, { once: true })
    if (signal.aborted) end()
  })
  const heard = new AbortController()
  const listening = AbortSignal.any([signal, heard.signal])
  const hear = async (): Promise<void> => {
    while (options.steered && !listening.aborted) {
      await options.steered(listening)
      while (!listening.aborted && (!liveSteer || queued > 0)) await new Promise<void>(go => { nudge = go; listening.addEventListener('abort', () => go(), { once: true }) })
      if (listening.aborted) return
      const said = takeSteer()
      if (!said.length) continue
      if (await liveSteer!([withSteer('', said)]).catch(() => false)) renew()
      else unread.push(...said)
    }
  }
  void hear()
  try {
    signal.throwIfAborted()
    const run = runTools.call(deps.engine, job)
    session = await Promise.race([run, ended, new Promise<ToolSessionResult>(resolve => { close = resolve })])
    if (closed !== undefined) { const stop = () => lifetime.abort(new Error('The tool session has ended.')), limit = setTimeout(stop, CLOSE_TAIL_MS); void run.catch(() => undefined).finally(() => { clearTimeout(limit); stop() }) }
    let lateLeft = LATE_STEER_ROUNDS
    const takeLate = async (): Promise<boolean> => {
      let took = false
      while (lateLeft > 0 && closed === undefined && !signal.aborted && !session.error && !asked) {
        const late = takeSteer()
        if (!late.length) break
        lateLeft--; took = true
        options.onReset?.(true)
        exhausted = false; extended = false; startedCalls = 0; working = Date.now()
        session = await Promise.race([runTools.call(deps.engine, { ...job, prompt: `${job.prompt}\n\n${lateSteer(session.answer, late)}` }), ended])
      }
      return took
    }
    await takeLate()
    if (closed === undefined && !signal.aborted && !session.error && !asked && !session.answer.trim() && session.note?.trim()) {
      const note = session.note
      working = Date.now()
      session = await Promise.race([runTools.call(deps.engine, { ...job, prompt: `${job.prompt}\n\n${UNSAID_NOTE}` }), ended])
      if (!session.answer.trim() && !session.error && !options.lookup && theirLanguage(note, task)) session = { answer: note }
      await takeLate()
    }
    let gap: string | undefined
    do gap = closed === undefined && !signal.aborted && !session.error && !asked ? await Promise.race([options.recheck?.(session.answer), ended.then(() => undefined)]) : undefined
    while (await takeLate())
    if (gap && !signal.aborted) {
      const draft = session.answer
      options.onReset?.(true)
      exhausted = false; extended = false; startedCalls = Math.max(0, allowance() - RECHECK_CALLS); working = Date.now()
      session = await Promise.race([runTools.call(deps.engine, { ...job, prompt: `${job.prompt}\n\n${recheckNote(draft, gap)}` }), ended])
      if (!session.answer.trim() && !session.error) session = { ...session, answer: draft }
      await takeLate()
    }
    const short = closed === undefined && !signal.aborted && !session.error && !asked && session.answer.trim() ? options.shortfall?.(session.answer) : undefined
    if (short) session = { ...session, answer: `${session.answer.trimEnd()}\n\n${short}` }
  } finally {
    heard.abort()
    options.onSteerable?.(null)
    clearInterval(watchdog)
    unfinishedCalls = queued > 0
    if (closed === undefined) { if (!signal.aborted) release(); lifetime.abort(new Error('The tool session has ended.')) }
    signal.removeEventListener('abort', end)
    running.clear(); queued = 0
    options.onMetric?.({ kind: 'host', operation: 'runtime-and-model-overhead', ms: Math.max(0, Math.round(Date.now() - started - toolMs)) })
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('canceled')
  if (closed !== undefined) return { answer: withoutSecrets(closed, task), steps, files: outputCards(steps, closed, deps.workdir), fellBack: false, tokensUsed }
  if (budgetExhausted) { const text = [`${budgetNote} Work so far is preserved; inspect the current state before continuing.`, collection.summary()].filter(Boolean).join("\n\n"); return { answer: withoutSecrets(text, task), steps, files: outputCards(steps, text, deps.workdir), fellBack: false, tokensUsed, budgetExhausted: true, incomplete: budgetNote } }
  if (asked) {
    const { question, options: choices } = asked as { question: string; options: string[] }
    return { answer: withoutSecrets(question, task), steps, fellBack: false, asked: true, options: choices }
  }
  if (stalled) {
    options.onMetric?.({ kind: 'host', operation: 'tool-deadline' })
    return { answer: withoutSecrets(`Not verified as complete.\n\n${stallNote}`, task), steps, files: outputCards(steps, '', deps.workdir), fellBack: false, incomplete: stallNote }
  }
  if (session.error) throw new Error(session.error)
  const finish = collection.finish()
  if (finish?.status === 'blocked') { const text = [finish.summary, collection.unverified()].filter(Boolean).join('\n\n'); return { answer: withoutSecrets(text, task), steps, files: outputCards(steps, text, deps.workdir), fellBack: false, asked: true } }
  const incomplete = [collection.unverified(), finish?.status === 'partial' ? finish.summary : undefined].filter(Boolean).join('\n\n') || (!finish && collection.open() ? 'Registered collection items remain unverified.' : unfinishedCalls ? 'The session ended before all requested tool results were verified.' : (options.lookup ? undefined : finalDesktopFailure(steps)) ?? evidenceFault(steps) ?? officeWriteUnverified(steps) ?? officeArithmeticFault(steps))
  const stopped = exhausted || startedCalls >= (extended ? CALL_CEILING : allowance())
  const answer = incomplete || stopped
    ? `Not verified as complete.\n\n${incomplete ?? 'The tool-call or time limit was reached.'}\n\nUnverified response:\n${session.answer.trim()}`
    : session.answer.trim()
  return { answer: withoutSecrets(answer, task), steps, files: outputCards(steps, answer, deps.workdir), fellBack: false, ...(stopped ? { stopped: 'calls' as const } : {}), ...(incomplete ? { incomplete } : {}) }
}

export async function runComet(deps: AgentLoopDeps, task: string, options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
  if (options.onToolStart) deps = { ...deps, tools: deps.tools.map((tool): AgentLoopDeps['tools'][number] => ({
    ...tool,
    run: (args, context) => { options.onToolStart!(tool.name); return tool.run(args, context) },
    ...(tool.runRich ? { runRich: (args, context) => { options.onToolStart!(tool.name); return tool.runRich!(args, context) } } : {}),
  })) }
  const session = !!deps.engine.runTools && options.guided === false
  const start = performance.now()
  try { return await (session ? runToolSession(deps, task, options) : runAgentLoop(deps, task, options)) }
  finally { options.onMetric?.({ kind: 'turn', operation: session ? 'session' : 'step', ms: Math.round(performance.now() - start) }) }
}
