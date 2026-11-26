import { join } from 'node:path'
import { addBotTask, calendarLine, createBot, engineCwd, initVault, loadBots, offerStudyTool, removeBotTask, runComet, type AgentLoopResult, type AgentTool, type Engine, type VaultPaths, type WebCourier } from 'core'
import { beginFirstLine, endFirstLine, firstLineNote, firstLineReady, firstLineSpoke } from './first-line.js'
import { taskRoot } from './file-work.js'
import { fetchPlainPage } from './plain-page.js'
import { addStudyOffer } from './study-offers.js'
import { toolKit } from './tool-kit.js'
import { threadKorean } from './usage-limit.js'

type LoopOptions = NonNullable<Parameters<typeof runComet>[2]>
type AckInputs = Parameters<typeof beginFirstLine>[0]
type Turn = { role: string; text: string }

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

export interface AnswerOptions extends Omit<LoopOptions, 'signal' | 'takeSteer' | 'onToken' | 'onReset' | 'onStep' | 'attachmentContext' | 'skills'> {
  signal?: AbortSignal
  takeSteer?(): string[]
  tools?: AgentTool[]
  imagePaths?: string[]
  ack?: Partial<Omit<AckInputs, 'message' | 'workdir' | 'signal'>>
  context?(): string
  skills?(): Promise<NonNullable<LoopOptions['skills']>>
  onToken?(text: string, held: boolean): void
  onReset?(drop?: boolean, tool?: string): void
  onStep?(line: string): void
}

export interface Answered { trace: AnswerTrace; result?: AgentLoopResult; failure?: unknown }

export interface Answering {
  run(options?: Omit<AnswerOptions, 'signal' | 'ack'>): Promise<Answered>
  end(): void
}

export const lastReplyOf = (history?: readonly Turn[]): string | undefined => [...(history ?? [])].reverse().find(one => one.role === 'assistant')?.text

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
  const { signal, ack, ...rest } = options
  const answering = beginAnswer(world, message, { ...(signal ? { signal } : {}), ...(ack ? { ack } : {}) })
  try { return await answering.run(rest) } finally { answering.end() }
}

export function beginAnswer(world: World, message: string, options: Pick<AnswerOptions, 'signal' | 'ack'> = {}): Answering {
  const { paths, botId, engine } = world
  const { signal, ack: asked = {} } = options
  const started = performance.now()
  const ms = () => Math.round(performance.now() - started)
  const trace: AnswerTrace = { message, steps: [], final: { text: '', ms: 0 }, end: 'done' }
  const channel = asked.channel ?? `bot-${botId}`
  const korean = asked.korean ?? threadKorean(message, world.history)
  const turn = signal ?? new AbortController().signal
  beginFirstLine({
    interactive: true, studying: false, limited: false, secret: false, engine: async () => engine,
    ...asked,
    channel, message, korean, workdir: engineCwd(paths), signal: turn,
    show: line => { trace.first ??= { text: line, ms: ms() }; asked.show?.(line) },
  })
  firstLineReady(channel)
  const run = async (options: Omit<AnswerOptions, 'signal' | 'ack'> = {}): Promise<Answered> => {
    const { takeSteer, tools, imagePaths, context, onToken, onReset, onStep, skills, native, ...loop } = options
    let streamed = '', firstLine = false, result: AgentLoopResult | undefined, failure: unknown
    const everyTool = tools ?? worldTools(world, message, signal)
    try {
      const note = firstLineNote(channel)
      const shortlist = skills ? await skills() : undefined
      const notes = [context?.(), calendarLine(), note].filter(Boolean).join('\n\n')
      result = await runComet({ engine, workdir: engineCwd(paths), tools: everyTool, ...(imagePaths ? { imagePaths } : {}) }, message, {
        guided: false,
        session: botId,
        history: world.history,
        ...loop,
        ...(shortlist ? { skills: shortlist } : {}),
        ...(native ? { native } : {}),
        ...(signal ? { signal } : {}),
        ...(takeSteer ? { takeSteer } : {}),
        ...(notes ? { attachmentContext: notes } : {}),
        onStep: line => { trace.steps.push({ line, ms: ms() }); onStep?.(line) },
        onToken: text => {
          const hold = !!firstLineNote(channel)
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
      })
      trace.final = { text: result.answer, ms: ms() }
    } catch (cause) {
      failure = cause
      trace.final = { text: streamed, ms: ms() }
      trace.error = cause instanceof Error ? cause.message : String(cause)
    }
    if (!trace.first && trace.final.text.trim()) trace.first = { text: trace.final.text.trim().split('\n')[0]!, ms: trace.final.ms }
    if (signal?.aborted) trace.end = 'stop'
    world.history.push({ role: 'user', text: message }, { role: 'assistant', text: trace.final.text })
    return { trace, ...(result ? { result } : { failure }) }
  }
  return { run, end: () => endFirstLine(channel) }
}
