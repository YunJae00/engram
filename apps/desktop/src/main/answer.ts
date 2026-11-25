import { join } from 'node:path'
import { addBotTask, createBot, engineCwd, initVault, loadBots, offerStudyTool, removeBotTask, runComet, type AgentLoopResult, type AgentTool, type Engine, type VaultPaths, type WebCourier } from 'core'
import { beginFirstLine, endFirstLine, fallbackLine, firstLineNote, firstLineNow, firstLineReady, firstLineSpoke, smallTalkAnswer } from './first-line.js'
import { taskRoot } from './file-work.js'
import { fetchPlainPage } from './plain-page.js'
import { addStudyOffer } from './study-offers.js'
import { toolKit } from './tool-kit.js'
import { threadKorean } from './usage-limit.js'

type LoopOptions = NonNullable<Parameters<typeof runComet>[2]>
type AckInputs = Parameters<typeof beginFirstLine>[0]

export interface World {
  paths: VaultPaths
  botId: string
  engine: Engine
  courier?: WebCourier
  history: NonNullable<LoopOptions['history']>
}

export interface AnswerTrace {
  message: string
  first?: { text: string; ms: number }
  steps: { line: string; ms: number }[]
  final: { text: string; ms: number }
  end: 'done' | 'stop'
  error?: string
}

export interface AnswerOptions extends Omit<LoopOptions, 'signal' | 'takeSteer' | 'onToken' | 'onReset' | 'onStep' | 'attachmentContext'> {
  signal?: AbortSignal
  takeSteer?(): string[]
  tools?: AgentTool[]
  imagePaths?: string[]
  ack?: Partial<Omit<AckInputs, 'message' | 'workdir' | 'signal'>> & { now?: boolean; reply?: boolean }
  held?: boolean
  context?(): string
  rounds?(round: (ask: string, signal: AbortSignal) => Promise<AgentLoopResult>): Promise<AgentLoopResult>
  onToken?(text: string, held: boolean): void
  onReset?(drop?: boolean, tool?: string): void
  onStep?(line: string): void
}

export interface Answered { trace: AnswerTrace; result?: AgentLoopResult; failure?: unknown }

const plainCourier: WebCourier = { fetchPage: (url, signal) => fetchPlainPage(url, signal, fetch) }

export async function openWorld(dir: string, engine: Engine, courier: WebCourier = plainCourier): Promise<World> {
  const paths = await initVault(join(dir, 'vault'), { git: false })
  const bot = await createBot(paths, { name: 'Engram' })
  return { paths, botId: bot.id, engine, courier, history: [] }
}

function worldTools(world: World, message: string, signal?: AbortSignal): AgentTool[] {
  const { paths, botId } = world
  const kit = toolKit({
    paths,
    channel: `bot-${botId}`,
    courier: world.courier ?? plainCourier,
    retrieve: async () => [],
    log: () => {},
    bot: {
      schedule: {
        list: async () => (await loadBots(paths)).flatMap(bot => bot.tasks ?? []),
        add: input => addBotTask(paths, botId, input),
        remove: async id => { const had = (await loadBots(paths)).some(bot => bot.tasks?.some(task => task.id === id)); await removeBotTask(paths, botId, id); return had },
      },
      chief: false,
      changed: () => {},
      said: () => message,
    },
    files: { readable: [], workFolder: join(taskRoot(paths), `bot-${botId}`), consent: {}, host: { app: { getPath: () => paths.workspace }, assertDesktopTurnNotStopped: () => signal?.throwIfAborted() } },
  })
  return [...kit.web, ...kit.files, ...kit.team, ...kit.learning, offerStudyTool({ offer: input => addStudyOffer(paths, botId, input, message) })]
}

export async function answer(world: World, message: string, options: AnswerOptions = {}): Promise<Answered> {
  const { paths, botId, engine } = world
  const { signal, takeSteer, tools, imagePaths, ack = {}, held, context, rounds, onToken, onReset, onStep, ...loop } = options
  const { now, reply, ...asked } = ack
  const started = performance.now()
  const ms = () => Math.round(performance.now() - started)
  const trace: AnswerTrace = { message, steps: [], final: { text: '', ms: 0 }, end: 'done' }
  const channel = asked.channel ?? `bot-${botId}`
  const korean = asked.korean ?? threadKorean(message, world.history)
  const turn = signal ?? new AbortController().signal
  let streamed = '', firstLine = false, result: AgentLoopResult | undefined, failure: unknown
  beginFirstLine({
    interactive: true, studying: false, limited: false, followUp: false, secret: false, engine: async () => engine, fallback: said => fallbackLine(message, korean, said),
    ...asked,
    channel, message, korean, workdir: engineCwd(paths), signal: turn,
    show: line => { trace.first ??= { text: line, ms: ms() }; asked.show?.(line) },
  })
  try {
    firstLineReady(channel)
    if (now) firstLineNow(channel, message, korean)
    const talked = reply === false ? undefined : await smallTalkAnswer(channel)
    const note = firstLineNote(channel)
    const lead = (ask: string, within: AbortSignal): Promise<AgentLoopResult> => { const notes = [context?.(), note].filter(Boolean).join('\n\n'); return runComet({ engine, workdir: engineCwd(paths), tools: tools ?? worldTools(world, message, signal), ...(imagePaths ? { imagePaths } : {}) }, ask, {
      guided: false,
      session: botId,
      history: world.history,
      ...loop,
      signal: within,
      ...(takeSteer ? { takeSteer } : {}),
      ...(notes ? { attachmentContext: notes } : {}),
      onStep: line => { trace.steps.push({ line, ms: ms() }); onStep?.(line) },
      onToken: text => {
        const hold = !!held || !!firstLineNote(channel)
        if (!hold) {
          firstLineSpoke(channel)
          streamed += text
          const shown = streamed.trim()
          if (shown && !firstLine) {
            trace.first ??= { text: '', ms: ms() }
            trace.first.text = shown.split('\n')[0]!
            firstLine = shown.includes('\n')
          }
        }
        onToken?.(text, hold)
      },
      onReset: (drop, tool) => { streamed = ''; onReset?.(drop, tool) },
    }) }
    result = talked ? { answer: talked, steps: [], fellBack: false } : await (rounds ? rounds(lead) : lead(message, turn))
    trace.final = { text: result.answer, ms: ms() }
  } catch (cause) {
    failure = cause
    trace.final = { text: streamed, ms: ms() }
    trace.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    endFirstLine(channel)
  }
  if (!trace.first && trace.final.text.trim()) trace.first = { text: trace.final.text.trim().split('\n')[0]!, ms: trace.final.ms }
  if (signal?.aborted) trace.end = 'stop'
  world.history.push({ role: 'user', text: message }, { role: 'assistant', text: trace.final.text })
  return { trace, ...(result ? { result } : { failure }) }
}
