import { OBSERVATION_CAP, carriedSteps, pickTools, stepPrompt, stepSchema, suggestedMove, wrapUpPrompt, openStepSchema } from './agent-prompt.js'
import { choiceQuestion, parseAsk } from './ask.js'
import { asksForNote, noteTitleFor } from './search-template.js'
import { withoutSecrets } from './secrets.js'
import { collectResult, extractJson, type Engine, type EngineCwd } from './engine/types.js'

// The comet's working loop: think → pick ONE tool → run it → look at what
// came back, a handful of times, then answer. Small local models fail
// open-ended agent loops, so every wall here is load-bearing: the menu is
// tiny, the choice is schema-forced, the state lives in this code (the model
// sees only the last few observations), and every guard ends in a graceful
// wrap-up — never a dead end.

// What every tool is told besides its arguments: the words the person
// actually used. A small model paraphrases the request into tidy English and
// then searches a vault written in another language; with the original ask in
// hand, code can fall back to it instead of the model having to notice.
export interface AgentToolContext {
  task: string
  signal?: AbortSignal
  // Everything the loop has read so far this turn. A tool that fills in a form
  // needs it: what goes into a website has to come from something that was
  // actually read, never from the model's own head.
  read?: string
}

export interface AgentTool {
  name: string
  // One line for the menu — what it does and when to pick it.
  description: string
  // JSON schema for this tool's args, embedded into the step schema.
  argsSchema: object
  run(args: Record<string, unknown>, context: AgentToolContext): Promise<string>
}

export interface AgentLoopDeps {
  engine: Engine
  workdir: EngineCwd
  tools: AgentTool[]
}

export interface AgentLoopOptions {
  signal?: AbortSignal
  // One line of identity ("You are <name>... charter: ...") carried at the
  // top of every prompt the loop sends.
  persona?: string
  // The conversation so far. Without it a follow-up ("did you finish?") has
  // no subject, and the loop answers it from whatever the vault happened to
  // return — measured, and exactly as baffling as it sounds.
  history?: { role: 'user' | 'assistant'; text: string }[]
  // What this comet remembers about the person, rendered once by the caller
  // before the turn; the same bytes ride in every prompt of the turn.
  memory?: string
  // Guided: the loop narrows the menu each step, seeds what it knows, nudges
  // and budgets tightly - the hand-holding a small on-device model needs to
  // finish a job. Off, the model sees every tool and plans for itself.
  guided?: boolean
  // One narration line per step ("search_memory: deploy decisions") — the
  // chat thread relays these while the loop works.
  onStep?(line: string): void
  // What each step actually came back with. Nothing in the product listens to
  // this; the probes do, because a loop can only be fixed from what its tools
  // said, not from what it did next.
  onObservation?(tool: string, observation: string): void
  maxCalls?: number
}

export interface AgentLoopStep {
  tool: string
  args: Record<string, unknown>
  observation: string
  // Put there before the model was asked anything, rather than chosen. The
  // difference matters: a seeded fact must not make the opening move look
  // like work already under way.
  seeded?: boolean
}

export interface AgentLoopResult {
  answer: string
  steps: AgentLoopStep[]
  // Two broken outputs in a row forced the plain-answer path.
  fellBack: boolean
  // Set when a guard ended the loop early; the answer still wraps up with
  // whatever the steps gathered.
  stopped?: 'calls' | 'repetition' | 'oscillation'
  // The loop ended by putting a question to the person.
  asked?: boolean
  // Ways forward the person can pick from, beside the question in answer.
  // Empty or absent when the question is free text.
  options?: string[]
  // A move a tool asked for that was never made. Measured: pushed to act, a
  // small model may instead ANNOUNCE that it acted. The caller states the
  // truth alongside the answer rather than letting the claim stand.
  pending?: string
}

const MAX_CALLS = 6
// A brain that plans for itself is given room to: more moves, longer
// answers.
const OPEN_MAX_CALLS = 12
const OPEN_TOKENS = 1_200

const CALL_TIMEOUT_MS = 180_000
const SCHEMA_STRIKES = 2
// Tools that only look. A move into one of these can be made on the model's
// behalf; anything that writes, posts or runs still waits for a person.
const READ_ONLY = new Set(['open_page', 'read_open_page', 'read_note', 'search_memory', 'search_web'])

function sameArgs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}




// What this turn has actually READ - a note, a page - as opposed to what the
// loop has said to itself along the way. The difference decides what may be
// typed into a website: told that the procedure is called "work log upload",
// the model typed that name into the log as the day's work, and it passed a
// check that counted the loop's own scaffolding as reading.
const CONTENT_TOOLS = new Set(['search_memory', 'read_note', 'open_page', 'read_open_page', 'search_web'])

function readSoFar(steps: AgentLoopStep[]): string {
  return steps
    .filter((step) => CONTENT_TOOLS.has(step.tool))
    .map((step) => step.observation)
    .join('\n')
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
  const record = value as Record<string, unknown>
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

// The pending call, parsed. A small model reliably FINDS the procedure and
// then describes running it instead of running it; the host turns this into a
// one-tap offer rather than demanding the model be cleverer than it is.
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

// The two ways a small model gets stuck: hammering one call, and bouncing
// between two. Both read as progress from inside the loop, so the guard
// compares the recent call hashes instead.
export function detectLoop(keys: string[]): 'repetition' | 'oscillation' | null {
  const n = keys.length
  if (n >= 2 && keys[n - 1] === keys[n - 2]) return 'repetition'
  if (n >= 4 && keys[n - 1] === keys[n - 3] && keys[n - 2] === keys[n - 4] && keys[n - 1] !== keys[n - 2])
    return 'oscillation'
  return null
}

async function plainAnswer(deps: AgentLoopDeps, task: string, steps: AgentLoopStep[], options: AgentLoopOptions): Promise<string> {
  // A password the person typed does not come back out. The answer is kept
  // with the thread, so repeating it there would outlive the moment it was
  // needed - and it was never needed here, since nothing signs in on their
  // behalf.
  return withoutSecrets(await answerText(deps, task, steps, options), task)
}

async function answerText(deps: AgentLoopDeps, task: string, steps: AgentLoopStep[], options: AgentLoopOptions): Promise<string> {
  return collectResult(deps.engine, {
    prompt: wrapUpPrompt(task, steps, options.persona, options.history, options.memory, options.guided !== false),
    workdir: deps.workdir,
    disallowTools: true,
    timeoutMs: CALL_TIMEOUT_MS,
    modelHint: 'fast',
    maxTokens: options.guided === false ? OPEN_TOKENS : ANSWER_TOKENS,
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

export { carriedSteps, pickTools }

// A tool call is a name and a few arguments; a note body is the one thing
// that needs room. The answer is a few short sentences by its own rule, and
// letting either run to the transport's default ceiling is a minute of a
// CPU-bound machine's time for nothing.
const STEP_TOKENS = 320
// A step that writes - a filled form, a note - carries a paragraph in its
// arguments, and a paragraph of Korean is most of 320 tokens by itself: the
// JSON was cut short and the form was run with the blank still empty.
const WRITING_TOOLS = new Set(['run_procedure', 'propose_note', 'propose_edit', 'propose_file'])
const WRITING_TOKENS = 640
const ANSWER_TOKENS = 400
function stepBudget(tools: AgentTool[]): number {
  return tools.some((t) => WRITING_TOOLS.has(t.name)) ? WRITING_TOKENS : STEP_TOKENS
}
// A read a tool asked for is made without asking the model - reading costs
// nothing and needs nobody's permission, and a step spent confirming a call
// the tool already named is a whole prompt evaluation on a CPU-bound machine.
// Capped per turn and never repeated with the same arguments, so a front page
// that keeps pointing at itself cannot spin.
const AUTO_READS = 3
// Below this an answer is a shrug, not something worth a card.
const NOTE_MIN = 80

async function writeDown(deps: AgentLoopDeps, task: string, text: string, steps: AgentLoopStep[], options: AgentLoopOptions): Promise<void> {
  const tool = deps.tools.find((t) => t.name === 'propose_note')
  if (!tool) return
  const args = { title: noteTitleFor(task), body: text.trim() }
  options.onStep?.(`${tool.name}: ${summarizeArgs(args)}`)
  const observation = await tool
    .run(args, { task, read: readSoFar(steps), ...(options.signal ? { signal: options.signal } : {}) })
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
  // From every tool it has, not just this step's menu.
  const tool = deps.tools.find((t) => t.name === next.tool)
  if (!tool) return false
  followed.count++
  options.onStep?.(`${tool.name}: ${summarizeArgs(next.args)}`)
  const observation = await tool
    .run(next.args, { task, read: readSoFar(steps), ...(options.signal ? { signal: options.signal } : {}) })
    .catch((err: unknown) => `that did not work: ${err instanceof Error ? err.message : String(err)}`)
  options.onObservation?.(tool.name, observation)
  steps.push({ tool: tool.name, args: next.args, observation: observation.slice(0, OBSERVATION_CAP) })
  return true
}

export async function runAgentLoop(
  deps: AgentLoopDeps,
  task: string,
  options: AgentLoopOptions = {},
): Promise<AgentLoopResult> {
  // Chosen per step, not once: an empty vault search is what earns the web
  // tools their place on the menu.
  const conversed = (options.history?.length ?? 0) > 0
  const guided = options.guided !== false
  const menu = (steps: AgentLoopStep[]): AgentTool[] => (guided ? pickTools(deps.tools, task, steps, conversed) : deps.tools)
  let tools = menu([])
  const maxCalls = options.maxCalls ?? (guided ? MAX_CALLS : OPEN_MAX_CALLS)
  const steps: AgentLoopStep[] = []
  const keys: string[] = []
  let strikes = 0
  // The one-time push from "describing the next call" to "making it".
  let nudged = false
  const followed = { count: 0 }
  const wrapUp = async (stopped?: AgentLoopResult['stopped'], fellBack = false): Promise<AgentLoopResult> => ({
    answer: await plainAnswer(deps, task, steps, options),
    steps,
    fellBack,
    ...(stopped ? { stopped } : {}),
    ...(suggestedMove(steps) ? { pending: suggestedMove(steps)! } : {}),
  })
  // Before the model is asked anything: is this a job they already showed it?
  // A colleague checks that first, every time, and it costs no thinking.
  const knows = deps.tools.find((one) => one.name === 'find_procedure')
  if (knows) {
    const observation = await knows
      .run({ task }, { task, ...(options.signal ? { signal: options.signal } : {}) })
      .catch(() => '')
    // Only when it really knows the job. Announcing "I was never shown this"
    // at the top of every conversation taught the model to answer that to
    // anything, including "write this down for me".
    // A brain that plans for itself is not told what it cannot do: read as
    // an instruction, that line made a capable model refuse to look.
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
    try {
      raw = await collectResult(deps.engine, {
        prompt: stepPrompt(task, tools, steps, options.persona, options.history, options.memory, guided),
        workdir: deps.workdir,
        disallowTools: true,
        timeoutMs: CALL_TIMEOUT_MS,
        modelHint: 'fast',
        maxTokens: guided ? stepBudget(tools) : OPEN_TOKENS,
        jsonSchema: guided ? stepSchema(tools) : openStepSchema(tools),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (err) {
      // A call that hung or died must not throw away what the loop already
      // gathered — measured: a browser and a model sharing a tight machine
      // timed a whole turn out after real work had been done. With nothing
      // gathered the caller hears the real error, as it should.
      if (options.signal?.aborted || steps.length === 0) throw err
      return wrapUp('calls')
    }
    const parsed = parseStep(raw, tools)
    if (!parsed) {
      // A broken shape gets one more try; two in a row means this model is
      // not going to speak JSON today — answer plainly instead of dead-ending.
      strikes++
      if (strikes >= SCHEMA_STRIKES) return wrapUp(undefined, true)
      continue
    }
    strikes = 0
    if (parsed.tool === 'answer') {
      // Measured: with everything gathered, a small model writes out the call
      // it should make instead of making it. One nudge — never more, or a
      // stubborn model would never be allowed to finish — turns the
      // description back into the action. Nothing is posted by this: the
      // person still approves at the submit gate.
      const pending = suggestedMove(steps)
      if (await followRead(deps, task, steps, options, followed)) continue
      // Asked for a note and about to end in prose: the same one nudge.
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
        // Asked for a note, nudged once, and still answering in prose: the
        // prose is the note. Writing it down is the mechanical part, and the
        // loop does it - the person still approves the card (measured: two
        // notes merged into a good answer twice running, and no note either
        // time).
        if (unwritten && text.trim().length >= NOTE_MIN) await writeDown(deps, task, text, steps, options)
        // Prose that is really "A or B?" is a question with choices, and is
        // handed over as one so the person taps instead of typing.
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
    options.onStep?.(`${tool.name}: ${summarizeArgs(parsed.args)}`)
    let observation: string
    try {
      observation = await tool.run(parsed.args, { task, read: readSoFar(steps), ...(options.signal ? { signal: options.signal } : {}) })
      // A question to the person IS the answer: carrying on would mean
      // guessing at exactly the thing it just said it does not know.
      const ask = parseAsk(observation)
      if (ask) {
        steps.push({ tool: parsed.tool, args: parsed.args, observation })
        return { answer: withoutSecrets(ask.question, task), steps, fellBack: false, asked: true, options: ask.options }
      }
    } catch (err) {
      if (options.signal?.aborted) throw new Error('canceled')
      observation = `that did not work: ${err instanceof Error ? err.message : String(err)}`.slice(0, OBSERVATION_CAP)
    }
    options.onObservation?.(parsed.tool, observation)
    steps.push({ tool: parsed.tool, args: parsed.args, observation })
    await followRead(deps, task, steps, options, followed)
  }
  return wrapUp('calls')
}

function summarizeArgs(args: Record<string, unknown>): string {
  const first = Object.values(args).find((v) => typeof v === 'string')
  return typeof first === 'string' ? first.slice(0, 80) : JSON.stringify(args).slice(0, 80)
}
