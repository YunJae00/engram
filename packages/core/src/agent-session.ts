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
import { pageDelta } from './page-delta.js'
import { TASK_TOKEN_BUDGET } from './delegated-tasks.js'


export const SESSION_MAX_CALLS = 80
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
  let tokensUsed = 0, budgetExhausted = false
  const tokenBudget = options.tokenBudget ?? TASK_TOKEN_BUDGET
  const budgetNote = `The task token budget (${tokenBudget.toLocaleString('en-US')} tokens available for this turn) was reached.`
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
  let stalled = false, stallNote = ''
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
      const budget = allowance()
      const cost = tool.name === 'read_pages' && Array.isArray(args['pages']) ? Math.min(4, Math.max(1, args['pages'].length)) : 1
      const checkpoint = !exhausted && tool.name === 'task_plan' && startedCalls === budget && budget < Math.min(options.maxCalls ?? 120, 120)
        && Object.keys(args).length === 2 && typeof args['finding'] === 'string' && args['evidenceStep'] === steps.length
      const finding = browser && budget >= baseCalls && startedCalls + cost <= (options.maxCalls ?? CALL_CEILING)
      if (startedCalls + cost > budget && finding) extended = true
      if (startedCalls + cost > budget && !checkpoint && !finding) {
        exhausted = true
        return 'No more calls this turn. Report incomplete work and the last confirmed state; do not claim completion or propose saving this as a successful routine.'
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
      if ((tool.name === 'offer_study' || tool.name === 'study_findings') && !/^that did not work|^Nothing is being studied/.test(observation)) carded = true
      const ask = parseAsk(observation)
      if (ask) {
        asked = ask
        return 'The question is with the person. Reply with exactly that question and nothing else.'
      }
      const notes = [
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
    const settled = outcome.finally(() => { queued = Math.max(0, queued - 1) })
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
      if (tokensUsed >= tokenBudget) {
        budgetExhausted = true
        lifetime.abort(new Error(budgetNote))
      }
    },
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
        queued++; deciding++
        try { return await options.native!.decide(name, input, signal) } finally { deciding--; queued = Math.max(0, queued - 1) }
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
        running.delete(active); queued = Math.max(0, queued - 1); options.native!.onResult?.(name, ok)
      },
    } } : {}),
    tools: sessionCalls,
    onContextReset: () => { compactPage() },
    maxCalls: options.maxCalls ?? (browser ? CALL_CEILING : planned ? 120 : SESSION_MAX_CALLS),
    onToken: (text: string) => { if (text) options.onToken?.(text) },
    onSteerable: (steer) => { liveSteer = steer; options.onSteerable?.(steer) },
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
  try {
    signal.throwIfAborted()
    session = await Promise.race([runTools.call(deps.engine, job), ended])
  } finally {
    options.onSteerable?.(null)
    clearInterval(watchdog)
    unfinishedCalls = queued > 0
    lifetime.abort(new Error('The tool session has ended.'))
    signal.removeEventListener('abort', end)
    running.clear(); queued = 0
    options.onMetric?.({ kind: 'host', operation: 'runtime-and-model-overhead', ms: Math.max(0, Math.round(Date.now() - started - toolMs)) })
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('canceled')
  if (budgetExhausted) return { answer: withoutSecrets(outputLinks(steps, `${budgetNote} Work so far is preserved; inspect the current state before continuing.`), task), steps, fellBack: false, tokensUsed, budgetExhausted: true, incomplete: budgetNote }
  if (asked) {
    const { question, options: choices } = asked as { question: string; options: string[] }
    return { answer: withoutSecrets(question, task), steps, fellBack: false, asked: true, options: choices }
  }
  if (stalled) {
    options.onMetric?.({ kind: 'host', operation: 'tool-deadline' })
    return { answer: withoutSecrets(outputLinks(steps, `Not verified as complete.\n\n${stallNote}`), task), steps, fellBack: false, incomplete: stallNote }
  }
  if (session.error) throw new Error(session.error)
  const finish = collection.finish()
  if (finish?.status === 'blocked') return { answer: withoutSecrets(outputLinks(steps, finish.summary), task), steps, fellBack: false, asked: true }
  const incomplete = (unfinishedCalls ? 'The session ended before all requested tool results were verified.' : finalDesktopFailure(steps) ?? evidenceFault(steps) ?? officeWriteUnverified(steps) ?? officeArithmeticFault(steps))
  const stopped = exhausted || startedCalls >= (extended ? CALL_CEILING : allowance())
  const answer = incomplete || stopped
    ? `Not verified as complete.\n\n${incomplete ?? 'The tool-call or time limit was reached.'}\n\nUnverified response:\n${session.answer.trim()}`
    : session.answer.trim()
  return { answer: withoutSecrets(outputLinks(steps, answer), task), steps, fellBack: false, ...(stopped ? { stopped: 'calls' as const } : {}), ...(incomplete ? { incomplete } : {}) }
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
