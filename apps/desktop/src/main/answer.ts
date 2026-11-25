import { join } from 'node:path'
import { addBotTask, createBot, engineCwd, initVault, loadBots, offerStudyTool, removeBotTask, runComet, type Engine, type VaultPaths, type WebCourier } from 'core'
import { fetchPlainPage } from './plain-page.js'
import { addStudyOffer } from './study-offers.js'
import { toolKit } from './tool-kit.js'

export interface World {
  paths: VaultPaths
  botId: string
  engine: Engine
  courier: WebCourier
  history: { role: 'user' | 'assistant'; text: string }[]
}

export interface AnswerTrace {
  message: string
  first?: { text: string; ms: number }
  steps: { line: string; ms: number }[]
  final: { text: string; ms: number }
  end: 'done' | 'stop'
  error?: string
}

const plainCourier: WebCourier = { fetchPage: (url, signal) => fetchPlainPage(url, signal, fetch) }

export async function openWorld(dir: string, engine: Engine, courier: WebCourier = plainCourier): Promise<World> {
  const paths = await initVault(join(dir, 'vault'), { git: false })
  const bot = await createBot(paths, { name: 'Engram' })
  return { paths, botId: bot.id, engine, courier, history: [] }
}

export async function answer(world: World, message: string, options: { signal?: AbortSignal; takeSteer?(): string[] } = {}): Promise<AnswerTrace> {
  const { paths, botId, engine } = world
  const started = performance.now()
  const ms = () => Math.round(performance.now() - started)
  const trace: AnswerTrace = { message, steps: [], final: { text: '', ms: 0 }, end: 'done' }
  let streamed = '', firstLine = false
  const kit = toolKit({
    paths,
    channel: `bot-${botId}`,
    courier: world.courier,
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
  })
  try {
    const result = await runComet({ engine, workdir: engineCwd(paths), tools: [...kit.web, ...kit.team, ...kit.learning, offerStudyTool({ offer: input => addStudyOffer(paths, botId, input, message) })] }, message, {
      guided: false,
      session: botId,
      history: world.history,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.takeSteer ? { takeSteer: options.takeSteer } : {}),
      onStep: line => { trace.steps.push({ line, ms: ms() }) },
      onToken: text => {
        streamed += text
        const shown = streamed.trim()
        if (!shown || firstLine) return
        trace.first ??= { text: '', ms: ms() }
        trace.first.text = shown.split('\n')[0]!
        firstLine = shown.includes('\n')
      },
      onReset: () => { streamed = '' },
    })
    trace.final = { text: result.answer, ms: ms() }
  } catch (cause) {
    trace.final = { text: streamed, ms: ms() }
    trace.error = cause instanceof Error ? cause.message : String(cause)
  }
  if (options.signal?.aborted) trace.end = 'stop'
  world.history.push({ role: 'user', text: message }, { role: 'assistant', text: trace.final.text })
  return trace
}
