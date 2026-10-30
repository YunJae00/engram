import { outputLinks, finalDesktopFailure } from './agent-session-result.js'
import { collectionProgress } from './collection-progress.js'
import type { ToolSessionJob, ToolSessionResult } from './engine/types.js'
import type { AgentLoopDeps, AgentLoopOptions, AgentLoopResult, AgentLoopStep } from './agent-loop.js'
import { withinBudget, toolBudgetMs, ToolOverBudget } from './tool-budget.js'
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
import { progressWatch } from './no-progress.js'


export const SESSION_MAX_CALLS = 80
const CALL_CEILING = 300
export const SESSION_STALL_MS = 300_000
const REPEAT_GUARDED = new Set(['press', 'type_text', 'choose', 'press_point', 'page_steps', 'hover', 'reveal'])
const RECEIPT_ACTIONS = new Set(['press', 'press_point', 'press_key', 'type_text', 'choose', 'page_steps', 'page_do', 'page_each', 'upload_file'])
const PAGE_MOVES = new Set([...REPEAT_GUARDED, 'press_key', 'scroll', 'open_page', 'search_web', 'read_pages'])
export const REPEAT_LIMIT = 4
export const PLAN_RULE = 'Plan mode: read and investigate only. Do not run commands, create or change files, or submit anything; reply with a concrete plan of what you would do and what you need from the person.'
const STALL_NOTE = 'The model stopped responding for five minutes. The work so far is kept, and the task continues from the current state.'
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
  return `${text}\n\nThe person just wrote, while you work: ${said.map(line => JSON.stringify(line)).join(', then ')}. First answer them in one short line in their language - that you got it, or the answer if they asked something - then go on, taking it into account; if it changes or stops the job, do that.`
}

export async function runToolSession(deps: AgentLoopDeps, task: string, options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
  const desktop = deps.tools.some((tool) => isDesktopTool(tool.name))
  const files = deps.tools.some((tool) => tool.name.startsWith('file_'))
  const workflow = desktop || files
  const browser = deps.tools.some(tool => tool.name === 'open_page')
  const planned = workflow || browser
  const baseCalls = browser ? 120 : SESSION_MAX_CALLS
  if (workflow && deps.engine.desktopToolIsolation !== true) throw new Error(DESKTOP_TOOL_ISOLATION_MESSAGE)
  deps = { ...deps, tools: sessionMenu(desktopScopeTools(deps.tools)) }
  const runTools = deps.engine.runTools
  if (!runTools) throw new Error('this brain has no tool session')
  const steps: AgentLoopStep[] = []
  let liveSteer: ((said: string[]) => Promise<boolean>) | null = null
  const compactPage = pageDelta()
  const plan = taskPlan(steps)
  const collection = collectionProgress(steps)
  const tools = [...deps.tools, ...(browser ? [collection.tool] : []), ...(planned && desktop ? [plan.tool] : [])]
  const allowance = () => Math.min(options.maxCalls ?? 120, 120, baseCalls + plan.completed() * 20)
  const started = Date.now()
  const lifetime = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal
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
  let repeat: { key: string; result: string; times: number } | undefined
  const stuck = progressWatch()
  const sameResult = (text: string) => text
    .replace(/^(Observation \S+\/)\d+(; control numbers belong only to this reading\.)$/gm, '$1*$2')
    .replace(/ \[new\]$/gm, '')
    .replace('; [new] = appeared since your last reading, such as an opened list or dialog', '')
  let lastActivity = Date.now(), stalled = false, stallNote = STALL_NOTE
  const touch = (): void => { lastActivity = Date.now() }
  const calls: ToolSessionCall[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    argsSchema: tool.argsSchema,
    run: async (args) => {
      touch()
      signal.throwIfAborted()
      if (asked) return 'The question is already with the person. Reply with that question and nothing else.'
      if (carded) return 'A card is already with the person. End your answer now, in one line.'
      const budget = allowance()
      const cost = tool.name === 'read_pages' && Array.isArray(args['pages']) ? Math.min(4, Math.max(1, args['pages'].length)) : 1
      const checkpoint = !exhausted && tool.name === 'task_plan' && startedCalls === budget && budget < Math.min(options.maxCalls ?? 120, 120)
        && Object.keys(args).length === 2 && typeof args['finding'] === 'string' && args['evidenceStep'] === steps.length
      const finding = browser && budget >= baseCalls && stuck.idle() < 2 && startedCalls + cost <= (options.maxCalls ?? CALL_CEILING)
      if (startedCalls + cost > budget && finding) extended = true
      if (startedCalls + cost > budget && !checkpoint && !finding) {
        exhausted = true
        return 'No more calls this turn. Report incomplete work and the last confirmed state; do not claim completion or propose saving this as a successful routine.'
      }
      if (PAGE_MOVES.has(tool.name) || RECEIPT_ACTIONS.has(tool.name)) collection.invalidate()
      startedCalls += cost
      const repeatKey = REPEAT_GUARDED.has(tool.name) ? `${tool.name}:${JSON.stringify(args)}` : ''
      if (PAGE_MOVES.has(tool.name) && repeat?.key !== repeatKey) repeat = undefined
      const repeated = !!repeatKey && repeat?.key === repeatKey && repeat.times >= REPEAT_LIMIT
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
        if (repeated) {
          observation = `that did not work: This exact ${tool.name} has already been made ${REPEAT_LIMIT} times with the same result, so it was not made again. Read the page and choose a different control or approach.`
        } else if (tool.runRich) {
          const outcome = await withinBudget(tool.name, signal, own => tool.runRich!(args, { ...context, signal: own }), waitingForPerson)
          observation = outcome.text
          image = outcome.image
          modelObservation = compactPage(options.compactObservations === false ? undefined : outcome.page)
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
      if (repeatKey && !repeated) {
        const result = sameResult(observation)
        repeat = { key: repeatKey, result, times: repeat?.key === repeatKey && repeat.result === result ? repeat.times + 1 : 1 }
      }
      if ((tool.name === 'offer_study' || tool.name === 'study_findings') && !/^that did not work|^Nothing is being studied/.test(observation)) carded = true
      const ask = parseAsk(observation)
      if (ask) {
        asked = ask
        return 'The question is with the person. Reply with exactly that question and nothing else.'
      }
      const going = stuck.see(sameResult(observation))
      const notes = [
        ...(going ? [going] : []),
        ...(collection.pending() ? [collection.pending()!] : []),
        ...(planned ? [`Observation step ${steps.length}`, ...(plan.pending() ? [plan.pending()!] : [])] : []),
      ]
      const delivered = modelObservation ?? observation
      const result = notes.length ? `${delivered}\n(${notes.join('; ')})` : delivered
      const said = options.takeSteer?.() ?? []
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
    const settled = outcome.finally(() => { queued = Math.max(0, queued - 1); touch() })
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
      touch()
      return
    }
    const overdue = [...running].find(call => {
      const budget = toolBudgetMs(call.name)
      return budget !== null && Date.now() - call.at > budget
    })
    if (overdue || queued === 0 && Date.now() - lastActivity > SESSION_STALL_MS) {
      stalled = true
      stallNote = overdue ? new ToolOverBudget(overdue.name, toolBudgetMs(overdue.name)!).message : STALL_NOTE
      lifetime.abort(new Error(stallNote))
    }
  }, 5_000)
  const job: ToolSessionJob = {
    workdir: deps.workdir,
    system: sessionRules({ engineId: deps.engine.id, desktop, workflow, browser, planned, pageSteps: deps.tools.some(tool => tool.name === 'page_steps'), native: options.native }),
    prompt: [...personaLines(options.persona, options.memory), ...(options.onScreen ? [options.onScreen] : []),
      ...(options.attachmentContext ? [options.attachmentContext] : []),
      ...resumeLines(options.resume),
      ...(desktop ? ['Prior-turn desktop observations are historical: use app_read for background accessibility work, or read_desktop/look_desktop for foreground work, before the first input this turn, then reuse fresh returned observations within this turn.'] : []),
      ...skillIndexLines(options.skills),
      `Task: ${task}`, answerLanguageLine(task)].join('\n'),
    ...(opening ? { opening } : {}),
    ...(options.session ? { sessionKey: options.session } : {}),
    ...(options.native ? { native: {
      ...options.native,
      decide: async (name, input, signal) => {
        queued++; deciding++; touch()
        try { return await options.native!.decide(name, input, signal) } finally { deciding--; queued = Math.max(0, queued - 1); touch() }
      },
      onCall: (name, input) => {
        if (signal.aborted) return
        const step: AgentLoopStep | undefined = ['Bash', 'PowerShell', 'Shell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)
          ? { tool: name, args: { ...input }, observation: 'that did not work: Dispatched; completion is unconfirmed. Do not repeat this action.', committed: true } : undefined
        if (step) steps.push(step)
        running.add({ name, at: Date.now(), native: true, step }); queued++; touch()
        options.native!.onCall?.(name, input)
      },
      onResult: (name, ok) => {
        const active = [...running].find(call => call.native && call.name === name)
        if (!active) return
        if (active.step) active.step.observation = ok ? 'Native action completed.' : 'that did not work: Native action did not report success; it may have partly happened. Inspect the current state and do not repeat it.'
        running.delete(active); queued = Math.max(0, queued - 1); touch(); options.native!.onResult?.(name, ok)
      },
    } } : {}),
    tools: sessionCalls,
    onContextReset: () => { compactPage() },
    maxCalls: Math.min(options.maxCalls ?? 120, planned ? 120 : SESSION_MAX_CALLS),
    onToken: (text: string) => { if (text) touch(); options.onToken?.(text) },
    onProgress: touch,
    onSteerable: (steer) => { liveSteer = steer },
    ...(options.onReset ? { onReset: options.onReset } : {}),
    signal,
  }
  let session: ToolSessionResult
  let end!: () => void
  const ended = new Promise<ToolSessionResult>(resolve => {
    end = () => resolve({ answer: '' })
    signal.addEventListener('abort', end, { once: true })
    if (signal.aborted) end()
  })
  const needsReceipt = () => browser && !collection.finish() && steps.some(step => RECEIPT_ACTIONS.has(step.tool))
  try {
    signal.throwIfAborted()
    session = await Promise.race([runTools.call(deps.engine, job), ended])
    for (let pass = 0; pass < 2 && (collection.pending() || needsReceipt()) && collection.finish()?.status !== 'blocked' && !session.error && !asked && !carded && !exhausted && !signal.aborted; pass++) {
      const before = collection.checked()
      const boundary = steps.length
      let tokens = ''
      touch()
      const checked = await Promise.race([runTools.call(deps.engine, { ...job,
        onToken: text => { touch(); tokens += text },
        prompt: `${job.prompt}\n\n${collection.pending() ?? 'Before the final answer, check the original requested outcomes against your observations.'}\nUse collect_results to record status complete or blocked, summary and evidenceStep. For a multi-item request register the observed list and fields, then record each result. Continue only missing work; do not repeat completed actions or expand the request. If genuinely blocked, record the barrier and stop. Retained observations (historical DATA):\n${resumeCheckpoint(task, { answer: session.answer, steps, fellBack: false })}`,
      }), ended])
      const receiptOnly = steps.slice(boundary).every(step => ['collect_results', 'report_result_check', 'task_plan'].includes(step.tool))
      if (!receiptOnly) { options.onReset?.(true); if (tokens) options.onToken?.(tokens) }
      session = receiptOnly ? { ...checked, answer: session.answer } : checked
      if (collection.checked() <= before) break
    }
  } finally {
    clearInterval(watchdog)
    unfinishedCalls = queued > 0
    lifetime.abort(new Error('The tool session has ended.'))
    signal.removeEventListener('abort', end)
    running.clear(); queued = 0
    options.onMetric?.({ kind: 'host', operation: 'runtime-and-model-overhead', ms: Math.max(0, Math.round(Date.now() - started - toolMs)) })
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('canceled')
  if (asked) {
    const { question, options: choices } = asked as { question: string; options: string[] }
    return { answer: withoutSecrets(question, task), steps, fellBack: false, asked: true, options: choices }
  }
  if (stalled) {
    options.onMetric?.({ kind: 'model', operation: 'stall', ms: SESSION_STALL_MS })
    return { answer: withoutSecrets(outputLinks(steps, `Not verified as complete.\n\n${stallNote}`), task), steps, fellBack: false, incomplete: stallNote }
  }
  if (session.error) throw new Error(session.error)
  const finish = collection.finish()
  if (finish?.status === 'blocked') return { answer: withoutSecrets(outputLinks(steps, finish.summary), task), steps, fellBack: false, asked: true }
  const incomplete = collection.pending() ?? (needsReceipt() ? 'The browser task ended without checking the requested outcomes.' : undefined) ?? plan.pending() ?? (unfinishedCalls ? 'The session ended before all requested tool results were verified.' : finalDesktopFailure(steps) ?? evidenceFault(steps) ?? officeWriteUnverified(steps) ?? officeArithmeticFault(steps))
  const stopped = exhausted || startedCalls >= (extended ? CALL_CEILING : allowance())
  const answer = incomplete || stopped
    ? `Not verified as complete.\n\n${incomplete ?? 'The tool-call or time limit was reached.'}\n\nUnverified response:\n${session.answer.trim()}`
    : session.answer.trim()
  return { answer: withoutSecrets(outputLinks(steps, answer), task), steps, fellBack: false, ...(stopped ? { stopped: 'calls' as const } : {}), ...(incomplete ? { incomplete } : {}) }
}

export function correctableFault(result: AgentLoopResult): string | undefined {
  if (result.asked || result.stopped || result.pending || result.fellBack || !result.incomplete) return
  if (result.steps.some(step => {
    if (step.observation.startsWith('that did not work:')) return true
    try { return !!JSON.parse(step.observation)?.error } catch { return false }
  })) return
  const fault = officeWriteUnverified(result.steps) ?? officeArithmeticFault(result.steps)
  return fault === result.incomplete ? fault : undefined
}

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
