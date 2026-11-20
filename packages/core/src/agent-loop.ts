import { OBSERVATION_CAP, carriedSteps, pickTools, stepPrompt, stepSchema, suggestedMove, wrapUpPrompt, openStepSchema } from './agent-prompt.js'
import type { NativeTools } from './engine/types.js'
import { choiceQuestion, parseAsk } from './ask.js'
import { asksForNote, noteTitleFor } from './search-template.js'
import { withoutSecrets } from './secrets.js'
import { desktopScopeTools, desktopStepArgs, desktopStepSummary, isDesktopTool } from './desktop-tools.js'
import { screenPrompt, textStepTools } from './agent-screen.js'
import { collectResult, DESKTOP_TOOL_ISOLATION_MESSAGE, extractJson, type Engine, type EngineCwd } from './engine/types.js'
import { checkOfficeResult } from './office-verification.js'
import type { WebPage } from './errand.js'
import type { HarnessMetric } from './harness-metrics.js'

export interface AgentToolContext {
  task: string
  signal?: AbortSignal
  steps?: readonly AgentLoopStep[]
  onObservedAfterAction?(): void
  onCommitted?(): void
  read?: string
}

export interface ToolOutcome {
  text: string
  image?: { data: string; mimeType: string }
  page?: WebPage
  observedAfterAction?: boolean
  committed?: boolean
}

export interface AgentTool {
  name: string
  description: string
  argsSchema: object
  run(args: Record<string, unknown>, context: AgentToolContext): Promise<string>
  runRich?(args: Record<string, unknown>, context: AgentToolContext): Promise<ToolOutcome>
  closes?: true | ((args: Record<string, unknown>) => boolean)
  closesOn?: (observation: string) => boolean
  closeAnswer?: (observation: string) => string | undefined
}

export interface AgentLoopDeps {
  engine: Engine
  workdir: EngineCwd
  tools: AgentTool[]
  imagePaths?: string[]
}

export interface AgentLoopOptions {
  tokenBudget?: number
  onUsage?(tokens: number): void
  waitingForPerson?(): boolean
  onToolStart?(name: string): void
  takeSteer?(): string[]
  onSteerable?(steer: ((messages: string[]) => Promise<boolean>) | null): void
  compactObservations?: boolean
  onMetric?(metric: HarnessMetric): void
  signal?: AbortSignal
  attachmentContext?: string
  persona?: string
  history?: { role: 'user' | 'assistant'; text: string; at?: string; attachments?: string[] }[]
  memory?: string
  skills?: { name: string; description: string }[]
  resume?: string
  guided?: boolean
  session?: string
  onScreen?: string
  native?: NativeTools
  onStep?(line: string): void
  onObservation?(tool: string, observation: string): void
  onToken?(text: string): void
  onReset?(dropDraft?: boolean, tool?: string): void
  maxCalls?: number
  modelHint?: 'fast' | 'smart'
  lookup?: boolean
  light?: boolean
  short?: boolean
  deadlineMs?: number
  onStart?(): void
  steerReplied?: boolean
  recheck?(answer: string): string | undefined | Promise<string | undefined>
  shortfall?(answer: string): string | undefined
}

export interface AgentLoopStep {
  committed?: boolean
  tool: string
  args: Record<string, unknown>
  observation: string
  observedAfterAction?: boolean
  seeded?: boolean
}

export interface FileCard { name: string; href: string; replaces?: string[] }

export interface AgentLoopResult {
  tokensUsed?: number
  budgetExhausted?: boolean
  answer: string
  steps: AgentLoopStep[]
  files?: FileCard[]
  fellBack: boolean
  stopped?: 'calls' | 'repetition' | 'oscillation'
  asked?: boolean
  options?: string[]
  pending?: string
  incomplete?: string
}

const MAX_CALLS = 6
const OPEN_MAX_CALLS = 12
const OPEN_TOKENS = 1_200

const CALL_TIMEOUT_MS = 180_000
const SCHEMA_STRIKES = 2
const READ_ONLY = new Set(['open_page', 'read_open_page', 'read_note', 'search_memory', 'search_web'])

function sameArgs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}



const CONTENT_TOOLS = new Set(['read_pages', 'search_memory', 'read_note', 'open_page', 'read_open_page', 'search_web', 'look_in_parallel'])

function readSoFar(steps: AgentLoopStep[], history?: AgentLoopOptions['history']): string {
  return [...said(history), ...steps.filter((step) => CONTENT_TOOLS.has(step.tool)).map((step) => step.observation)].join('\n')
}

export function said(history: AgentLoopOptions['history']): string[] {
  return (history ?? [])
    .filter((turn) => turn.role === 'user')
    .slice(-4)
    .map((turn) => turn.text)
}

interface ParsedStep {
  tool: string
  args: Record<string, unknown>
}

function parseStep(text: string, tools: AgentTool[]): ParsedStep | null {
  let value: unknown
  try {
    value = extractJson(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const root = value as Record<string, unknown>
  const record = root['step'] && typeof root['step'] === 'object' ? root['step'] as Record<string, unknown> : root
  const tool = record['tool']
  const args = record['args']
  if (typeof tool !== 'string') return null
  if (tool !== 'answer' && !tools.some((t) => t.name === tool)) return null
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  return { tool, args: args as Record<string, unknown> }
}

function callKey(step: ParsedStep): string {
  return `${step.tool} ${JSON.stringify(step.args)}`
}

export function parsePendingCall(pending: string | undefined): { tool: string; args: Record<string, unknown> } | null {
  if (!pending) return null
  const match = /call ([a-z_]+) with (\{.*\})/i.exec(pending)
  if (!match) return null
  try {
    const args = JSON.parse(match[2]!) as unknown
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
    return { tool: match[1]!, args: args as Record<string, unknown> }
  } catch {
    return null
  }
}

export function detectLoop(keys: string[]): 'repetition' | 'oscillation' | null {
  const n = keys.length
  if (n >= 2 && keys[n - 1] === keys[n - 2]) return 'repetition'
  if (n >= 4 && keys[n - 1] === keys[n - 3] && keys[n - 2] === keys[n - 4] && keys[n - 1] !== keys[n - 2])
    return 'oscillation'
  return null
}

async function plainAnswer(deps: AgentLoopDeps, task: string, steps: AgentLoopStep[], options: AgentLoopOptions): Promise<string> {
  return withoutSecrets(await answerText(deps, task, steps, options), task)
}

async function answerText(deps: AgentLoopDeps, task: string, steps: AgentLoopStep[], options: AgentLoopOptions): Promise<string> {
  return collectResult(deps.engine, {
    prompt: screenPrompt(wrapUpPrompt(task, steps, options.persona, options.history, options.memory, options.guided !== false, options.skills, options.resume), options.onScreen, deps.tools, options.attachmentContext),
    workdir: deps.workdir,
    ...(deps.imagePaths?.length ? { imagePaths: deps.imagePaths } : {}),
    disallowTools: true,
    ...(deps.tools.some((tool) => isDesktopTool(tool.name)) ? { requireToolIsolation: true } : {}),
    timeoutMs: CALL_TIMEOUT_MS,
    modelHint: 'fast',
    maxTokens: options.guided === false ? OPEN_TOKENS : ANSWER_TOKENS,
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

export { carriedSteps, pickTools }

const STEP_TOKENS = 320
const WRITING_TOOLS = new Set(['run_procedure', 'propose_note', 'propose_edit', 'propose_file'])
const WRITING_TOKENS = 640
const ANSWER_TOKENS = 400
function stepBudget(tools: AgentTool[]): number {
  return tools.some((t) => WRITING_TOOLS.has(t.name)) ? WRITING_TOKENS : STEP_TOKENS
}
const AUTO_READS = 3
const NOTE_MIN = 80

async function writeDown(deps: AgentLoopDeps, task: string, text: string, steps: AgentLoopStep[], options: AgentLoopOptions): Promise<void> {
  const tool = deps.tools.find((t) => t.name === 'propose_note')
  if (!tool) return
  const args = { title: noteTitleFor(task), body: text.trim() }
  options.onStep?.(`${tool.name}: ${summarizeArgs(args)}`)
  const observation = await tool
    .run(args, { task, read: readSoFar(steps, options.history), ...(options.signal ? { signal: options.signal } : {}) })
    .catch((err: unknown) => `that did not work: ${err instanceof Error ? err.message : String(err)}`)
  options.onObservation?.(tool.name, observation)
  steps.push({ tool: tool.name, args, observation: observation.slice(0, OBSERVATION_CAP) })
}

async function followRead(
  deps: AgentLoopDeps,
  task: string,
  steps: AgentLoopStep[],
  options: AgentLoopOptions,
  followed: { count: number },
): Promise<boolean> {
  const next = parsePendingCall(suggestedMove(steps) ?? undefined)
  if (!next || !READ_ONLY.has(next.tool) || followed.count >= AUTO_READS) return false
  if (steps.some((s) => s.tool === next.tool && sameArgs(s.args, next.args))) return false
  const tool = deps.tools.find((t) => t.name === next.tool)
  if (!tool) return false
  followed.count++
  options.onStep?.(`${tool.name}: ${summarizeArgs(next.args)}`)
  let observedAfterAction = false
  const observation = await tool
    .run(next.args, { task, read: readSoFar(steps, options.history), onObservedAfterAction: () => { observedAfterAction = true }, ...(options.signal ? { signal: options.signal } : {}) })
    .catch((err: unknown) => { observedAfterAction = false; return `that did not work: ${err instanceof Error ? err.message : String(err)}` })
  options.onObservation?.(tool.name, observation)
  steps.push({ tool: tool.name, args: next.args, observation: observation.slice(0, OBSERVATION_CAP), ...(observedAfterAction ? { observedAfterAction: true } : {}) })
  return true
}

export async function runAgentLoop(deps: AgentLoopDeps, task: string, options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
  return checkOfficeResult(await agentLoop(deps, task, options))
}

async function agentLoop(
  deps: AgentLoopDeps,
  task: string,
  options: AgentLoopOptions = {},
): Promise<AgentLoopResult> {
  if (deps.tools.some((tool) => isDesktopTool(tool.name)) && deps.engine.desktopToolIsolation !== true) throw new Error(DESKTOP_TOOL_ISOLATION_MESSAGE)
  deps = { ...deps, tools: desktopScopeTools(deps.tools) }
  const conversed = (options.history?.length ?? 0) > 0
  const guided = options.guided !== false
  const available = textStepTools(deps.tools)
  const menu = (steps: AgentLoopStep[]): AgentTool[] => (guided ? pickTools(available, task, steps, conversed, (options.history ?? []).slice(-3).filter((turn) => turn.role === 'user').map((turn) => turn.text).join('\n')) : available)
  let tools = menu([])
  const maxCalls = options.maxCalls ?? (guided ? MAX_CALLS : OPEN_MAX_CALLS)
  const steps: AgentLoopStep[] = []
  const keys: string[] = []
  let strikes = 0
  let nudged = false
  const followed = { count: 0 }
  const wrapUp = async (stopped?: AgentLoopResult['stopped'], fellBack = false): Promise<AgentLoopResult> => ({
    answer: await plainAnswer(deps, task, steps, options),
    steps,
    fellBack,
    ...(stopped ? { stopped } : {}),
    ...(suggestedMove(steps) ? { pending: suggestedMove(steps)! } : {}),
  })
  const knows = deps.tools.find((one) => one.name === 'find_procedure')
  if (knows) {
    const observation = await knows
      .run({ task }, { task, ...(options.signal ? { signal: options.signal } : {}) })
      .catch(() => '')
    const quiet = /^found /.test(observation)
      ? observation
      : guided && observation.startsWith('NOTHING-TAUGHT')
        ? 'NOTHING-TAUGHT: no saved procedure covers this. You can read and write things down, but you cannot work a website you were never shown.'
        : ''
    if (quiet)
      steps.push({ tool: 'find_procedure', args: { task }, observation: quiet.slice(0, OBSERVATION_CAP), seeded: true })
  }

  for (let call = 0; call < maxCalls; call++) {
    if (options.signal?.aborted) throw new Error('canceled')
    tools = menu(steps)
    let raw: string
    const modelStarted = performance.now()
    try {
      raw = await collectResult(deps.engine, {
        prompt: screenPrompt(stepPrompt(task, tools, steps, options.persona, options.history, options.memory, guided, options.skills, options.resume), options.onScreen, deps.tools, options.attachmentContext),
        workdir: deps.workdir,
        ...(deps.imagePaths?.length ? { imagePaths: deps.imagePaths } : {}),
        disallowTools: true,
        ...(deps.tools.some((tool) => isDesktopTool(tool.name)) ? { requireToolIsolation: true } : {}),
        timeoutMs: CALL_TIMEOUT_MS,
        modelHint: 'fast',
        maxTokens: guided ? stepBudget(tools) : OPEN_TOKENS,
        jsonSchema: guided ? stepSchema(tools) : openStepSchema(tools),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (err) {
      if (options.signal?.aborted || steps.length === 0) throw err
      const reason = withoutSecrets(err instanceof Error ? err.message : String(err), task).slice(0, 1200)
      const result = await wrapUp('calls').catch(() => ({ answer: 'The task did not finish.', steps, fellBack: false, stopped: 'calls' as const }))
      return { ...result, incomplete: `The model could not continue: ${reason}`, answer: `${result.answer}\n\nStopped: ${reason}` }
    }
    options.onMetric?.({ kind: 'model', operation: 'step', ms: Math.round(performance.now() - modelStarted) })
    const parsed = parseStep(raw, tools)
    if (!parsed) {
      strikes++
      if (strikes >= SCHEMA_STRIKES) return wrapUp(undefined, true)
      continue
    }
    strikes = 0
    if (parsed.tool === 'answer') {
      const pending = suggestedMove(steps)
      if (await followRead(deps, task, steps, options, followed)) continue
      const unwritten =
        guided && asksForNote(task) && !steps.some((s) => WRITING_TOOLS.has(s.tool)) && deps.tools.some((t) => t.name === 'propose_note')
      if (guided && (pending || unwritten) && !nudged) {
        nudged = true
        steps.push({
          tool: 'note-to-self',
          args: {},
          observation: pending
            ? `The work is not done yet — ${pending}. Fill any blanks from what you gathered above, and make that call now.`
            : 'The person asked for this written down, and nothing has been yet — call propose_note with {"title": "...", "body": "..."} carrying what you gathered above.',
        })
        continue
      }
      const text = parsed.args['text']
      const unfinished = pending ? { pending } : {}
      if (typeof text === 'string' && text.trim()) {
        if (unwritten && text.trim().length >= NOTE_MIN) await writeDown(deps, task, text, steps, options)
        const choice = choiceQuestion(text)
        if (choice) return { answer: withoutSecrets(text, task), steps, fellBack: false, asked: true, options: choice.options }
        return { answer: withoutSecrets(text, task), steps, fellBack: false, ...unfinished }
      }
      return wrapUp()
    }
    keys.push(callKey(parsed))
    const looped = detectLoop(keys)
    if (looped) return wrapUp(looped)
    const tool = tools.find((t) => t.name === parsed.tool)!
    options.onStep?.(`${tool.name}: ${desktopStepSummary(tool.name, parsed.args) ?? summarizeArgs(parsed.args)}`)
    let observation: string
    let observedAfterAction = false, committed = false
    const toolStarted = performance.now()
    try {
      observation = await tool.run(parsed.args, { task, steps: steps.slice(), read: readSoFar(steps, options.history), onObservedAfterAction: () => { observedAfterAction = true }, onCommitted: () => { committed = true }, ...(options.signal ? { signal: options.signal } : {}) })
      const ask = parseAsk(observation)
      if (ask) {
        steps.push({ tool: parsed.tool, args: desktopStepArgs(parsed.tool, parsed.args), observation })
        return { answer: withoutSecrets(ask.question, task), steps, fellBack: false, asked: true, options: ask.options }
      }
    } catch (err) {
      if (options.signal?.aborted) throw new Error('canceled')
      observedAfterAction = false
      observation = `that did not work: ${err instanceof Error ? err.message : String(err)}`.slice(0, OBSERVATION_CAP)
    }
    options.onMetric?.({ kind: 'tool', operation: tool.name, ms: Math.round(performance.now() - toolStarted) })
    options.onObservation?.(parsed.tool, observation)
    steps.push({ tool: parsed.tool, args: desktopStepArgs(parsed.tool, parsed.args), observation, ...(observedAfterAction ? { observedAfterAction: true } : {}), ...(committed ? { committed: true } : {}) })
    await followRead(deps, task, steps, options, followed)
  }
  return wrapUp('calls')
}

function summarizeArgs(args: Record<string, unknown>): string {
  const first = Object.values(args).find((v) => typeof v === 'string')
  return typeof first === 'string' ? first.slice(0, 80) : JSON.stringify(args).slice(0, 80)
}
