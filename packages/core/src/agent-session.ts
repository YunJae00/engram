import type { AgentLoopDeps, AgentLoopOptions, AgentLoopResult, AgentLoopStep } from './agent-loop.js'
import { withinBudget } from './tool-budget.js'
import { sessionMenu } from './session-menu.js'
import { runAgentLoop, said } from './agent-loop.js'
import { conversationLines, personaLines, resumeLines, skillIndexLines } from './agent-prompt.js'
import { parseAsk } from './ask.js'
import { DESKTOP_TOOL_ISOLATION_MESSAGE, type ToolSessionCall } from './engine/types.js'
import { sessionRules } from './agent-session-shape.js'
import { withoutSecrets } from './secrets.js'
import { answerLanguageLine } from './task-proposal.js'
import { desktopScopeTools, desktopStepArgs, desktopStepSummary, isDesktopTool } from './desktop-tools.js'
import { taskPlan } from './agent-plan.js'
import { officeWriteUnverified } from './office-verification.js'
import { officeArithmeticFault } from './office-arithmetic.js'
import { evidenceFault } from './work-evidence.js'
import { resumeCheckpoint } from './agent-resume.js'
import { pageDelta } from './page-delta.js'
import { pageRecovery } from './page-recovery.js'

// A brain that can hold its own tool loop is handed the tools once and runs
// the whole turn in one session: every step then costs one exchange instead
// of one fresh process, and the model keeps the pages it already read. The
// step loop stays for a brain that cannot, and for the guided small one.

// Real work on a page is a dozen small moves - open, read, type, choose,
// check - before anything has been achieved, and a budget that runs out
// mid-job hands the person a half-finished turn to restart by hand. So the
// budget is sized for the whole job, and is there only to stop a page that
// will not load from becoming a hundred tries.
const SESSION_MAX_CALLS = 40
// Bound silent model waits. Silence can also mean long reasoning, so retain
// unfinished work rather than claiming the model or the task failed.
export const SESSION_STALL_MS = 180_000
// Page moves held to account for repeating themselves, and how often the same
// move may come back the same before the next one is refused.
const REPEAT_GUARDED = new Set(['press', 'type_text', 'choose', 'press_point', 'page_steps', 'hover', 'reveal'])
const PAGE_MOVES = new Set([...REPEAT_GUARDED, 'press_key', 'scroll', 'open_page', 'search_web', 'read_pages'])
const REPEAT_LIMIT = 2
export const PLAN_RULE = 'Plan mode: read and investigate only. Do not run commands, create or change files, or submit anything; reply with a concrete plan of what you would do and what you need from the person.'
const STALL_NOTE = 'The model stopped responding for three minutes. The work so far is kept, and the task continues from the current state.'

const CONTENT_TOOLS = new Set(['read_pages', 'file_read', 'file_read_package', 'file_read_workbook', 'read_live_document', 'edit_live_document', 'compose_live_document', 'search_memory', 'read_note', 'open_page', 'read_open_page', 'search_web', 'press', 'type_text', 'choose', 'page_steps', 'scroll', 'hover', 'press_key', 'press_point', 'reveal', 'look'])

function readSoFar(steps: AgentLoopStep[], history?: AgentLoopOptions['history']): string {
  return [...said(history), ...steps.filter((step) => CONTENT_TOOLS.has(step.tool)).map((step) => step.observation)].join('\n')
}

function summarizeArgs(args: Record<string, unknown>): string {
  const first = Object.values(args).find((value) => typeof value === 'string' && value.trim())
  return typeof first === 'string' ? first.slice(0, 80) : ''
}

function outputLinks(steps: AgentLoopStep[], answer: string): string {
  const selected = new Set([...answer.matchAll(/\]\(engram-artifact:([A-Za-z0-9%_.-]+)\)/g)].map(match => match[1]!))
  const fileName = (id: string) => decodeURIComponent(id).replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i, '')
  const outputs: { link: string; id: string; name: string }[] = []
  const links = new Set<string>()
  for (const step of steps) {
    if (!['file_create_copy', 'file_create_workbook', 'file_edit_package', 'capture_evidence'].includes(step.tool)) continue
    try {
      const result = JSON.parse(step.observation) as { markdownLink?: unknown }
      const match = typeof result.markdownLink === 'string' && result.markdownLink.match(/^\[[^\]\r\n]+\]\(engram-artifact:([A-Za-z0-9%_.-]+)\)$/)
      if (match) outputs.push({ link: result.markdownLink as string, id: match[1]!, name: fileName(match[1]!) })
    } catch { /* Failed writes have no output receipt. */ }
  }
  // Respect an explicit final revision without deleting earlier files or guessing
  // which version wins when the answer has not selected one.
  const chosenNames = new Set(outputs.filter(output => selected.has(output.id)).map(output => output.name))
  for (const output of outputs) if (!selected.has(output.id) && !chosenNames.has(output.name)) links.add(output.link)
  return links.size ? `${answer}\n\n${[...links].join('\n\n')}` : answer
}

function finalDesktopFailure(steps: AgentLoopStep[]): string | undefined {
  const browser = steps.filter(step => ['read_pages', 'read_open_page', 'open_page', 'verify'].includes(step.tool)).at(-1)
  if (browser?.tool === 'read_pages' && browser.observation.startsWith('that did not work:')) return 'The last batch stopped before all pages were read. Inspect the current state and continue only unfinished reads.'
  const step = steps.filter((one) => one.tool.startsWith('file_') || ['app_read', 'app_text', 'app_set', 'app_press', 'app_do', 'desktop_action', 'desktop_sequence', 'read_desktop', 'look_desktop', 'read_live_document', 'edit_live_document', 'compose_live_document'].includes(one.tool)).at(-1)
  if (!step) return undefined
  const incomplete = 'The last computer or file result failed or may be stale and has not been verified.'
  if (step.observation.startsWith('that did not work:')) return incomplete
  if (step.tool === 'app_set' || step.tool === 'app_text' || step.tool === 'app_do') {
    try {
      const result = JSON.parse(step.observation) as { landed?: boolean; exact?: boolean; settled?: boolean; status?: string }
      if (result.landed === false || result.exact === false || result.settled === false || step.tool === 'app_do' && result.status !== 'done') return incomplete
    } catch { return incomplete }
  }
  if (!['app_set', 'app_press', 'desktop_action', 'desktop_sequence', 'read_live_document', 'edit_live_document', 'compose_live_document'].includes(step.tool)) return undefined
  try {
    const result = JSON.parse(step.observation) as { error?: unknown; observationMayBeStale?: unknown; reobserveRequired?: unknown; completeReadback?: unknown }
    if (result.error || result.observationMayBeStale === true || result.reobserveRequired === true || (step.tool === 'edit_live_document' && result.completeReadback !== true)) return incomplete
  } catch { return undefined }
  return undefined
}

// Words the person sent while the work was going, put in front of the brain
// at the next tool result: it answers them in a line and carries on with them
// in mind, the way a colleague takes a remark without dropping what they hold.
export function withSteer(text: string, said: string[]): string {
  if (!said.length) return text
  return `${text}\n\nThe person just wrote, while you work: ${said.map(line => JSON.stringify(line)).join(', then ')}. First answer them in one short line in their language - that you got it, or the answer if they asked something - then go on, taking it into account; if it changes or stops the job, do that.`
}

export async function runToolSession(deps: AgentLoopDeps, task: string, options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
  const desktop = deps.tools.some((tool) => isDesktopTool(tool.name))
  const files = deps.tools.some((tool) => tool.name.startsWith('file_'))
  const workflow = desktop || files
  const browser = deps.tools.some(tool => tool.name === 'open_page')
  const planned = workflow || browser
  // Browser work once earned calls past 80 through self-checkpoints; without
  // them it gets the ceiling directly. Repetition guards still end a loop.
  const baseCalls = browser ? 120 : SESSION_MAX_CALLS
  if (workflow && deps.engine.desktopToolIsolation !== true) throw new Error(DESKTOP_TOOL_ISOLATION_MESSAGE)
  deps = { ...deps, tools: sessionMenu(desktopScopeTools(deps.tools)) }
  const runTools = deps.engine.runTools
  if (!runTools) throw new Error('this brain has no tool session')
  const steps: AgentLoopStep[] = []
  let liveSteer: ((said: string[]) => Promise<boolean>) | null = null
  const compactPage = pageDelta()
  const recovery = pageRecovery()
  const plan = taskPlan(steps)
  // File/browser work uses direct result checks. Desktop sequences retain
  // phase checkpoints for their control rules and bounded call allowance.
  const tools = [...deps.tools, ...(planned && desktop ? [plan.tool] : [])]
  const allowance = () => Math.min(options.maxCalls ?? 120, 120, baseCalls + plan.completed() * 20)
  const started = Date.now()
  const lifetime = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal
  let startedCalls = 0
  let queued = 0
  let toolTail = Promise.resolve()
  let asked: { question: string; options: string[] } | null = null
  const canSearch = deps.tools.some((tool) => tool.name === 'search_web')
  let lookedFirst = false
  let exhausted = false
  let toolMs = 0
  // ponytail: guard identical consecutive moves, not multi-action cycles;
  // the total call budget bounds cycles. Reads alone do not reset the guard.
  let repeat: { key: string; result: string; times: number } | undefined
  const sameResult = (text: string) => text
    .replace(/^(Observation \S+\/)\d+(; control numbers belong only to this reading\.)$/gm, '$1*$2')
    .replace(/ \[new\]$/gm, '')
    .replace('; [new] = appeared since your last reading, such as an opened list or dialog', '')
  let lastActivity = Date.now(), stalled = false
  const touch = (): void => { lastActivity = Date.now() }
  const calls: ToolSessionCall[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    argsSchema: tool.argsSchema,
    run: async (args) => {
      touch()
      signal.throwIfAborted()
      // A question to the person ends the turn: whatever the model says
      // after it, the question is the answer.
      if (asked) return 'The question is already with the person. Reply with that question and nothing else.'
      // A turn has a budget of calls, or a page that will not load becomes a
      // hundred tries; past it the answer is made from what is in hand.
      const budget = allowance()
      const cost = tool.name === 'read_pages' && Array.isArray(args['pages']) ? Math.min(4, Math.max(1, args['pages'].length)) : 1
      // A final observation can use the phase allowance; let its checkpoint
      // earn the next bounded phase, but never exceed the total call ceiling.
      const checkpoint = !exhausted && tool.name === 'task_plan' && startedCalls === budget && budget < Math.min(options.maxCalls ?? 120, 120)
        && Object.keys(args).length === 2 && typeof args['finding'] === 'string' && args['evidenceStep'] === steps.length
      if (startedCalls + cost > budget && !checkpoint) {
        exhausted = true
        return 'No more calls this turn. Report incomplete work and the last confirmed state; do not claim completion or propose saving this as a successful routine.'
      }
      // Looking comes before asking: the first question of a turn, put
      // before the person's own search page was tried, is sent to the
      // search instead. Asked again after looking, it goes through.
      if (tool.name === 'ask_person' && !files && canSearch && !lookedFirst && !steps.some((step) => step.tool === 'search_web' || step.tool === 'open_page' || isDesktopTool(step.tool))) {
        lookedFirst = true
        return `Look before you ask: call search_web with {"query": "${task.slice(0, 80).replace(/"/g, "'")}"} first. Ask only if that comes back with nothing, or if the ask names no job at all.`
      }
      startedCalls += cost
      const repeatKey = REPEAT_GUARDED.has(tool.name) ? `${tool.name}:${JSON.stringify(args)}` : ''
      if (PAGE_MOVES.has(tool.name) && repeat?.key !== repeatKey) repeat = undefined
      const repeated = !!repeatKey && repeat?.key === repeatKey && repeat.times >= REPEAT_LIMIT
      const recoveryBlock = recovery.before(tool.name, args)
      options.onStep?.(`${tool.name}: ${desktopStepSummary(tool.name, args) ?? summarizeArgs(args)}`)
      let observation: string
      let modelObservation: string | undefined
      let image: { data: string; mimeType: string } | undefined
      let observedAfterAction = false, committed = false
      const toolStarted = performance.now()
      try {
        const context = { task, steps: steps.slice(), read: readSoFar(steps, options.history), signal }
        // A brain in a session can look at a picture; the words are what
        // the turn keeps, the picture goes to the brain and nowhere else.
        if (repeated) {
          observation = `that did not work: This exact ${tool.name} has already been made ${REPEAT_LIMIT} times with the same result, so it was not made again. Read the page and choose a different control or approach, or report what blocks the task.`
        } else if (recoveryBlock) {
          observation = recoveryBlock
        } else if (tool.runRich) {
          const outcome = await withinBudget(tool.name, signal, own => tool.runRich!(args, { ...context, signal: own }))
          observation = outcome.text
          image = outcome.image
          modelObservation = compactPage(options.compactObservations === false ? undefined : outcome.page)
          observedAfterAction = outcome.observedAfterAction === true
          committed = outcome.committed === true
        } else observation = await withinBudget(tool.name, signal, own => tool.run(args, { ...context, signal: own }))
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
      steps.push({ tool: tool.name, args: desktopStepArgs(tool.name, args), observation, ...(observedAfterAction ? { observedAfterAction: true } : {}), ...(committed ? { committed: true } : {}) })
      if (!repeated && !recoveryBlock) recovery.after(tool.name, args, observation)
      if (repeatKey && !repeated) {
        const result = sameResult(observation)
        repeat = { key: repeatKey, result, times: repeat?.key === repeatKey && repeat.result === result ? repeat.times + 1 : 1 }
      }
      const ask = parseAsk(observation)
      if (ask) {
        asked = ask
        return 'The question is with the person. Reply with exactly that question and nothing else.'
      }
      // The last few calls are counted out loud, so the answer is written
      // before the budget is gone rather than after.
      const left = allowance() - startedCalls
      const notes = [
        ...(planned ? [`Observation step ${steps.length}`, ...(plan.pending() ? [plan.pending()!] : [])] : []),
        ...(left <= 5 ? [`${left} call${left === 1 ? '' : 's'} left this turn`] : []),
      ]
      const delivered = modelObservation ?? observation
      const result = notes.length ? `${delivered}\n(${notes.join('; ')})` : delivered
      // The person's words go in as their own message where the brain takes
      // that; otherwise they ride with this result.
      const said = options.takeSteer?.() ?? []
      const text = said.length && liveSteer && await liveSteer(said).catch(() => false) ? result : withSteer(result, said)
      return image ? { text, image } : text
    },
  }))
  // Desktop callbacks share one changing foreground and observation history.
  // Queue them locally without another model exchange; recheck guards on entry.
  const sessionCalls = calls.map((call): ToolSessionCall => ({ ...call, run: (args) => {
    queued++
    const outcome = planned ? toolTail.then(() => call.run(args)) : call.run(args)
    const settled = outcome.finally(() => { queued--; touch() })
    if (planned) toolTail = settled.then(() => undefined, () => undefined)
    return settled
  } }))
  // The standing rules make the system prompt, the same for every turn, so
  // a brain that keeps its session open can keep it; who is speaking and
  // what they want travel with each turn, and the conversation so far only
  // with the first.
  const opening = conversationLines(options.history).join('\n')
  const watchdog = setInterval(() => {
    if (queued === 0 && Date.now() - lastActivity > SESSION_STALL_MS) {
      stalled = true
      lifetime.abort(new Error(STALL_NOTE))
    }
  }, 5_000)
  const session = await runTools.call(deps.engine, {
    workdir: deps.workdir,
    system: sessionRules({ engineId: deps.engine.id, desktop, workflow, browser, planned, pageSteps: deps.tools.some(tool => tool.name === 'page_steps'), native: options.native }),
    // The last thing said before the work is the language to answer in:
    // the pages ahead are usually in another one, and whichever language
    // fills the turn wins by weight alone unless this is said last - and
    // said by name, not left to be read off the ask.
    prompt: [...personaLines(options.persona, options.memory), ...(options.onScreen ? [options.onScreen] : []),
      ...(options.attachmentContext ? [options.attachmentContext] : []),
      ...resumeLines(options.resume),
      ...(desktop ? ['Prior-turn desktop observations are historical: use read_desktop or look_desktop before the first input this turn, then reuse fresh returned observations within this turn.'] : []),
      ...skillIndexLines(options.skills),
      `Task: ${task}`, answerLanguageLine(task)].join('\n'),
    ...(opening ? { opening } : {}),
    ...(options.session ? { sessionKey: options.session } : {}),
    ...(options.native ? { native: {
      ...options.native,
      // A permission card waiting on the person is work in progress, not silence.
      decide: async (name, input, signal) => {
        queued++; touch()
        try { return await options.native!.decide(name, input, signal) } finally { queued = Math.max(0, queued - 1); touch() }
      },
      onCall: (name, input) => { options.native!.onCall?.(name, input); queued++; touch() },
      onResult: (name, ok) => { queued = Math.max(0, queued - 1); touch(); options.native!.onResult?.(name, ok) },
    } } : {}),
    tools: sessionCalls,
    onContextReset: () => { compactPage() },
    maxCalls: Math.min(options.maxCalls ?? 120, planned ? 120 : SESSION_MAX_CALLS),
    onToken: (text: string) => { if (text) touch(); options.onToken?.(text) },
    onProgress: touch,
    onSteerable: (steer) => { liveSteer = steer },
    ...(options.onReset ? { onReset: options.onReset } : {}),
    signal,
  }).finally(() => {
    clearInterval(watchdog)
    lifetime.abort(new Error('The tool session has ended.'))
    options.onMetric?.({ kind: 'model', operation: 'session-overhead', ms: Math.max(0, Math.round(Date.now() - started - toolMs)) })
  })
  if (options.signal?.aborted) throw new Error('canceled')
  if (asked) {
    const { question, options: choices } = asked as { question: string; options: string[] }
    return { answer: withoutSecrets(question, task), steps, fellBack: false, asked: true, options: choices }
  }
  if (stalled) {
    options.onMetric?.({ kind: 'model', operation: 'stall', ms: SESSION_STALL_MS })
    return { answer: withoutSecrets(outputLinks(steps, `Not verified as complete.\n\n${STALL_NOTE}`), task), steps, fellBack: false, incomplete: STALL_NOTE }
  }
  if (session.error) throw new Error(session.error)
  const incomplete = plan.pending() ?? (queued ? 'The session ended before all requested tool results were verified.' : finalDesktopFailure(steps) ?? evidenceFault(steps) ?? officeWriteUnverified(steps) ?? officeArithmeticFault(steps))
  const stopped = exhausted || startedCalls >= allowance()
  const answer = incomplete || stopped
    ? `Not verified as complete.\n\n${incomplete ?? 'The tool-call or time limit was reached.'}\n\nUnverified response:\n${session.answer.trim()}`
    : session.answer.trim()
  return { answer: withoutSecrets(outputLinks(steps, answer), task), steps, fellBack: false, ...(stopped ? { stopped: 'calls' as const } : {}), ...(incomplete ? { incomplete } : {}) }
}

// Only document evidence gaps are repairable here, never control/approval failures.
export function correctableFault(result: AgentLoopResult): string | undefined {
  if (result.asked || result.stopped || result.pending || result.fellBack || !result.incomplete) return
  if (result.steps.some(step => {
    if (step.observation.startsWith('that did not work:')) return true
    try { return !!JSON.parse(step.observation)?.error } catch { return false }
  })) return
  const fault = officeWriteUnverified(result.steps) ?? officeArithmeticFault(result.steps)
  return fault === result.incomplete ? fault : undefined
}

// A correction observes its own segment. Rebase only host report receipts when
// joining trails; prior observations never become fresh correction evidence.
function correctionCheckSteps(steps: AgentLoopStep[], offset: number): AgentLoopStep[] {
  const rebase = (value: unknown) => JSON.parse(JSON.stringify(value), (key: string, item: unknown) =>
    key === 'refs' && Array.isArray(item) ? item.map(ref => {
      const match = typeof ref === 'string' && /^step:([1-9]\d*)$/.exec(ref)
      return match && Number.isSafeInteger(Number(match[1])) ? `step:${Number(match[1]) + offset}` : ref
    }) : item)
  return steps.map(step => {
    if (step.seeded || step.tool !== 'report_result_check') return step
    try {
      const value = JSON.parse(step.observation)
      if (!value?.resultCheck || value.error) return step
      return { ...step, args: rebase(step.args), observation: JSON.stringify({ ...value, resultCheck: rebase(value.resultCheck) }) }
    } catch { return step }
  })
}

// Preserve evidence across one bounded correction; a new session is not a clean bill of health.
export async function runComet(deps: AgentLoopDeps, task: string, options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
  if (options.onToolStart) deps = { ...deps, tools: deps.tools.map((tool): AgentLoopDeps['tools'][number] => ({
    ...tool,
    run: (args, context) => { options.onToolStart!(tool.name); return tool.run(args, context) },
    ...(tool.runRich ? { runRich: (args, context) => { options.onToolStart!(tool.name); return tool.runRich!(args, context) } } : {}),
  })) }
  const session = !!deps.engine.runTools && options.guided === false
  const budget = options.maxCalls ?? (session ? SESSION_MAX_CALLS : options.guided === false ? 12 : 6)
  let modelCalls = 0, correcting = false
  if (!session) {
    const source = deps.engine
    const counted = Object.create(source) as typeof source
    counted.run = async function* (job) {
      if (correcting && modelCalls >= budget) throw new Error('The model-call limit was reached.')
      modelCalls++
      yield* source.run(job)
    }
    deps = { ...deps, engine: counted }
  }
  const dispatch = async (opts: AgentLoopOptions): Promise<AgentLoopResult> => {
    const start = performance.now()
    try { return await (session ? runToolSession(deps, task, opts) : runAgentLoop(deps, task, opts)) }
    finally { opts.onMetric?.({ kind: 'turn', operation: session ? 'session' : 'step', ms: Math.round(performance.now() - start) }) }
  }
  const first = await dispatch(options)
  const fault = correctableFault(first)
  const usedCalls = first.steps.reduce((total, step) => total + (step.tool === 'read_pages' && Array.isArray(step.args['pages']) ? Math.min(4, Math.max(1, step.args['pages'].length)) : 1), 0)
  const calls = Math.min(12, budget - (session ? usedCalls : modelCalls))
  if (!fault || options.signal?.aborted || calls < 1 || /(?:do not|don't|no)\s+retr(?:y|ies)|stop.on.first.error|재시도.{0,12}(?:마|않)|첫 오류/i.test(task)) return first
  options.onReset?.(true)
  options.onStep?.('verification: Checking the unfinished result')
  correcting = true
  try {
    const corrected = await dispatch({ ...options, maxCalls: calls,
      ...(options.signal ? { signal: options.signal } : {}),
      resume: [options.resume, resumeCheckpoint(task, first), 'Recheck the affected targets and correct only unfinished work within the original request. Do not recreate outputs or repeat successful actions. If permission or user input is needed, ask and stop.'].filter(Boolean).join('\n\n'),
    })
    const steps = [...first.steps, ...correctionCheckSteps(corrected.steps, first.steps.length)]
    const incomplete = corrected.incomplete ?? evidenceFault(steps) ?? officeWriteUnverified(steps) ?? officeArithmeticFault(steps)
    const answer = incomplete && !corrected.incomplete && !corrected.asked
      ? `Not verified as complete.\n\n${incomplete}\n\nUnverified response:\n${corrected.answer}` : corrected.answer
    return { ...corrected, steps, answer: withoutSecrets(outputLinks(steps, answer), task), ...(incomplete ? { incomplete } : {}) }
  } catch (error) {
    options.signal?.throwIfAborted()
    const detail = error instanceof Error ? error.message : String(error)
    return { ...first, answer: withoutSecrets(`${first.answer}\n\nVerification correction stopped: ${detail}`, task) }
  }
}
