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

// replied: the host already gave the person a one-line reply (grokbar c3 T1/H6: the model's own reply came with its next tool result, at 6.7 s or never).
export function withSteer(text: string, said: string[], replied = false): string {
  if (!said.length) return text
  const words = `The person just wrote, while you work: ${said.map(line => JSON.stringify(line)).join(', then ')}.`
  return replied
    ? `${text}\n\n${words} They were already told in one short line that you got it: do not acknowledge, repeat or answer it again, and write nothing before your next step. Take it in now: when it adds to the job, do the added part too and give one answer that covers everything; when it replaces the job, do the new one only and leave the replaced one out of the answer; when it is only a remark (a complaint, thanks), go on unchanged. If it asked a question that one line could not have answered, answer it in your answer.`
    : `${text}\n\n${words} First answer them in one short line in their language - that you got it, or the answer if they asked something - then go on, taking it into account; if it changes or stops the job, do that.`
}

// What a lookup is told when its time or its calls are used up. grokbar c3: "Time is up for this part" and "No more calls this turn" came
// back to the person as "시간이 다 돼서 이번 턴에서는…" and "다시 시도해볼까요?".
export const ANSWER_NOW = 'Call no more tools. Answer now from what you already have, in the person\'s language: what you found, each fact with the address it came from, and in one plain clause what is not out yet or could not be found. Do not mention time, limits, turns, attempts or tools, do not apologize, and do not ask whether to try again or look further.'

const CLOSE_GRACE_MS = 150
const CLOSE_TAIL_MS = 15_000
// shortcut: words that keep coming past this many rewrites are answered as their own turn, raise it if people steer more often.
const LATE_STEER_ROUNDS = 3
// c11b: one more round for a gap the host found in the answer's shape: two calls (a search, or a read of a few pages), then the answer.
const RECHECK_CALLS = 2
export const recheckNote = (draft: string, gap: string): string => `You had just written this answer; the person has not been given it:\n${draft.trim()}\n\n${gap} Fix only that: search once more in other words or open the articles (read_pages), then write ONE answer that replaces this one and keeps what holds. If it still falls short, list what you found and do not write how many: a line with that count is put under your answer.`
// c11b r2: the model ended its turn with nothing after its last call; what it wrote before the call was a note to itself.
export const UNSAID_NOTE = 'You did your last step but wrote no answer after it; the words before it were notes and the person has not seen them. Call no more tools. Write your answer to the person now from what you already have, in their language.'
// Written in the language the person wrote in: in a Korean ask, Hangul and no Latin word they did not write themselves.
const theirLanguage = (text: string, task: string): boolean => !/[가-힣]/.test(task) || /[가-힣]/.test(text) && !(text.match(/[A-Za-z]+/g) ?? []).some(word => !task.toLowerCase().includes(word.toLowerCase()))
export function lateSteer(draft: string, said: string[], replied = false): string {
  return withSteer(`You had just written this answer; the person has not been given it as final:\n${draft.trim()}\n\nWrite ONE answer that replaces it: keep what still holds without redoing that work, do only the extra work their words need, and leave out what they replaced.`, said, replied)
}

export async function runToolSession(deps: AgentLoopDeps, task: string, options: AgentLoopOptions = {}): Promise<AgentLoopResult> {
  const desktop = deps.tools.some((tool) => isDesktopTool(tool.name))
  const files = deps.tools.some((tool) => tool.name.startsWith('file_'))
  const workflow = desktop || files
  // A lookup turn reads and reports: no collection receipts and no multi-stage rules (grokbar B6: one member spent 4 rounds, 10 s, on collect_results).
  // Only a work turn acts on pages (collect_results receipts, the browser call budget); a lookup or short ask reads them.
  const browser = !options.lookup && !options.short && deps.tools.some(tool => tool.name === 'open_page')
  const planned = workflow || browser
  // The turn kind picks which rules the session is sent (agent-session-shape sessionRules): a lookup or a short ask carries no work rules.
  const kind = options.lookup ? 'lookup' as const : options.short ? 'short' as const : 'work' as const
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
  // Words taken mid-lookup are a new ask: its time and its calls start again, once (grokbar c3 T2: "그냥 애플로 바꿔" was taken at 5 s and the 애플 search was refused at 12.96 s).
  let renewed = false
  const renew = (): void => { if (!options.lookup || renewed) return; renewed = true; exhausted = false; extended = false; startedCalls = 0; working = Date.now() }
  let stalled = false, stallNote = ''
  // A closing tool's reply is the answer (AgentTool.closes): the turn ends on it unless another kind of call ran this turn or one follows within the grace.
  let closed: string | undefined, composing = false, close: ((result: ToolSessionResult) => void) | undefined
  const closeLines: string[] = []
  // Once a closing tool has succeeded the model's words are held, not shown: dropped if the turn closes, shown in order if it goes on.
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
      // A lookup at its limit still hears the person: words waiting there change the job before the old one is answered (Codex b6 r3 #1).
      if (options.lookup && !renewed && (late || startedCalls + 1 > allowance())) {
        const waiting = options.takeSteer?.() ?? []
        if (waiting.length) { renew(); return withSteer('That call was not run.', waiting, options.steerReplied) }
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
          // Deltas are for work that acts on one page again and again; a lookup or short ask gets whole pages, so its rules carry no delta rule.
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
      const said = options.takeSteer?.() ?? []
      if (said.length) renew()
      // c16a r3: a reply its tool confirms as the whole answer (closesOn) closes whatever ran before it; only calls after it keep the turn open.
      const whole = tool.closesOn?.(observation)
      if (closing && (whole ?? !composing) && !said.length && !observation.startsWith('that did not work')) {
        if (whole) composing = false
        closeLines.push(observation)
        held ??= []
        const mark = startedCalls
        setTimeout(() => { if (startedCalls === mark && queued === 0 && !composing && !asked && !signal.aborted) { closed = closeLines.join('\n'); close?.({ answer: closed }) } }, CLOSE_GRACE_MS)
      } else release()
      const text = said.length && liveSteer && await liveSteer(said).catch(() => false) ? result : withSteer(result, said, options.steerReplied)
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
      ...(kind === 'work' ? [EARLIER_REPLIES_RULE] : []), `Task: ${task}`, answerLanguageLine(task)].join('\n'),
    ...(opening ? { opening } : {}),
    ...(options.session ? { sessionKey: options.session } : {}),
    ...(options.modelHint ? { modelHint: options.modelHint } : {}),
    // A lookup reads and reports: it needs no long thinking between calls (grokbar c3 R3: 14.5 s of model time between two searches).
    // c5c D1, M2: a note the host already read was answered after 20 s (1,330 of 1,586 output tokens were thinking), a one-word correction after 7.5 s.
    // A change of effort opens a fresh session (engine-claude-session.ts signatureOf); its first turn is given the thread so far (opening).
    ...(options.lookup || options.light ? { effort: 'low' as const } : {}),
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
    onStart: () => { working = Date.now(); options.onStart?.() },
    maxCalls: options.maxCalls ?? (browser ? CALL_CEILING : planned ? 120 : SESSION_MAX_CALLS),
    onToken: (text: string) => { if (!text || closed !== undefined) return; if (held) held.push(() => options.onToken?.(text)); else options.onToken?.(text) },
    onSteerable: (steer) => { liveSteer = steer; options.onSteerable?.(steer) },
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
  try {
    signal.throwIfAborted()
    const run = runTools.call(deps.engine, job)
    session = await Promise.race([run, ended, new Promise<ToolSessionResult>(resolve => { close = resolve })])
    // The model's own closing words are not waited for or shown, but its round is left to finish (bounded): cutting it would cost the warm session.
    if (closed !== undefined) { const stop = () => lifetime.abort(new Error('The tool session has ended.')), limit = setTimeout(stop, CLOSE_TAIL_MS); void run.catch(() => undefined).finally(() => { clearTimeout(limit); stop() }) }
    // Words said after the last tool result, while the answer was being written, had no tool result left to ride on: the answer is
    // written again with them, in the same turn, and the draft is dropped. grokbar B6 r3: "그냥 애플로 바꿔" got the 엔비디아 answer and a turn of its own.
    // c12b r2 (review #1): every wait after the first round (the note round, the host's verdict on the draft, its extra round) is a window
    // words can land in; each ends here, so words said at any point before delivery rewrite the one answer. True when words were taken.
    let lateLeft = LATE_STEER_ROUNDS
    const takeLate = async (): Promise<boolean> => {
      let took = false
      while (lateLeft > 0 && closed === undefined && !signal.aborted && !session.error && !asked) {
        const late = options.takeSteer?.() ?? []
        if (!late.length) break
        lateLeft--; took = true
        options.onReset?.(true)
        // The new words are a new ask: a turn that had used up its calls or its time gets both again for them (B6 r4: at the limit the words became a turn of their own).
        exhausted = false; extended = false; startedCalls = 0; working = Date.now()
        session = await Promise.race([runTools.call(deps.engine, { ...job, prompt: `${job.prompt}\n\n${lateSteer(session.answer, late, options.steerReplied)}` }), ended])
      }
      return took
    }
    await takeLate()
    // c11b r2 (review #3): a turn whose only words came before a tool call gets one round to say its answer; the note is never shown as
    // one unless that round, too, says nothing (a reply said before a save, "…기억해 둘게요." then keep_in_mind, is then kept as it was).
    if (closed === undefined && !signal.aborted && !session.error && !asked && !session.answer.trim() && session.note?.trim()) {
      const note = session.note
      working = Date.now()
      session = await Promise.race([runTools.call(deps.engine, { ...job, prompt: `${job.prompt}\n\n${UNSAID_NOTE}` }), ended])
      // c11b r3 (review #2): a note is the model's working words, written for itself; it stands in for an answer only when it is in the
      // person's own language (a reply said before a save, "…기억해 둘게요."), never as English narration in a Korean thread (rule 12).
      // stack-11 (c11b r3 #1): on a lookup the answer is what was found, so words said before a call ("먼저 자료를 찾아볼게요.") never
      // stand in, in any language: the answer stays empty and the host writes it from the rows it holds (desktop fast-lane heldAnswer).
      if (!session.answer.trim() && !session.error && !options.lookup && theirLanguage(note, task)) session = { answer: note }
      await takeLate()
    }
    // A verdict on a draft that words said during it have since rewritten is about the old ask: the rewritten answer is judged instead.
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
    // c12b r3 (review #1): the host's own steps before delivery are a wait like the others: words said during them are taken, the raw
    // answer is rewritten with them, and the rewrite is shaped again. Only an answer shaped from the last raw answer is delivered.
    if (options.deliver) {
      let shaped: string | undefined
      do shaped = closed === undefined && !signal.aborted && !session.error && !asked ? await Promise.race([options.deliver(session.answer), ended.then(() => undefined)]) : undefined
      while (await takeLate())
      if (shaped !== undefined && !signal.aborted && !session.error) session = { ...session, answer: shaped }
    }
    const short = closed === undefined && !signal.aborted && !session.error && !asked && session.answer.trim() ? options.shortfall?.(session.answer) : undefined
    if (short) session = { ...session, answer: `${session.answer.trimEnd()}\n\n${short}` }
  } finally {
    options.onSteerable?.(null)
    clearInterval(watchdog)
    unfinishedCalls = queued > 0
    if (closed === undefined) { if (!signal.aborted) release(); lifetime.abort(new Error('The tool session has ended.')) }
    signal.removeEventListener('abort', end)
    running.clear(); queued = 0
    options.onMetric?.({ kind: 'host', operation: 'runtime-and-model-overhead', ms: Math.max(0, Math.round(Date.now() - started - toolMs)) })
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('canceled')
  if (closed !== undefined) return { answer: withoutSecrets(closed, task), steps, fellBack: false, tokensUsed }
  if (budgetExhausted) return { answer: withoutSecrets(outputLinks(steps, [`${budgetNote} Work so far is preserved; inspect the current state before continuing.`, collection.summary()].filter(Boolean).join("\n\n"), deps.workdir), task), steps, fellBack: false, tokensUsed, budgetExhausted: true, incomplete: budgetNote }
  if (asked) {
    const { question, options: choices } = asked as { question: string; options: string[] }
    return { answer: withoutSecrets(question, task), steps, fellBack: false, asked: true, options: choices }
  }
  if (stalled) {
    options.onMetric?.({ kind: 'host', operation: 'tool-deadline' })
    return { answer: withoutSecrets(outputLinks(steps, `Not verified as complete.\n\n${stallNote}`, deps.workdir), task), steps, fellBack: false, incomplete: stallNote }
  }
  if (session.error) throw new Error(session.error)
  const finish = collection.finish()
  if (finish?.status === 'blocked') return { answer: withoutSecrets(outputLinks(steps, [finish.summary, collection.unverified()].filter(Boolean).join('\n\n'), deps.workdir), task), steps, fellBack: false, asked: true }
  const incomplete = [collection.unverified(), finish?.status === 'partial' ? finish.summary : undefined].filter(Boolean).join('\n\n') || (!finish && collection.open() ? 'Registered collection items remain unverified.' : unfinishedCalls ? 'The session ended before all requested tool results were verified.' : (options.lookup ? undefined : finalDesktopFailure(steps)) ?? evidenceFault(steps) ?? officeWriteUnverified(steps) ?? officeArithmeticFault(steps))
  const stopped = exhausted || startedCalls >= (extended ? CALL_CEILING : allowance())
  const answer = incomplete || stopped
    ? `Not verified as complete.\n\n${incomplete ?? 'The tool-call or time limit was reached.'}\n\nUnverified response:\n${session.answer.trim()}`
    : session.answer.trim()
  return { answer: withoutSecrets(outputLinks(steps, answer, deps.workdir), task), steps, fellBack: false, ...(stopped ? { stopped: 'calls' as const } : {}), ...(incomplete ? { incomplete } : {}) }
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
