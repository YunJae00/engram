import { join } from 'node:path'
import { addBotTask, createBot, engineCwd, initVault, keepRead, loadBots, offerStudyTool, removeBotTask, runComet, skipWalls, type AgentLoopResult, type AgentTool, type Engine, type VaultPaths, type WebCourier } from 'core'
import { closingBuilds, DESK_NOTE, DESK_TOOLS, deskKind, deskLane, deskLight, fileGiven, fixSlideTitle, keptFix, namedText, onlyTells, plainKeep, routeAsk, askNow, slideTitleFix, sortByKind, TOLD_NOTE } from './desk-lane.js'
import { fastLane, firstSearch, laneFirstLine, LANE_NOTE, LANE_SOLO_CALLS, LANE_SOLO_SOFT_MS, LANE_TEAM_CALLS, LANE_TOOLS, laneToday, quickQuestion, SHORT_QUESTION_NOTE, SMALL_TALK_NOTE, swapRounds, teamAsk } from './fast-lane.js'
import { beginFirstLine, endFirstLine, fallbackLine, firstLineNote, firstLineNow, firstLineReady, firstLineSpoke, plainReply, smallTalkAnswer } from './first-line.js'
import { namedBy, taskRoot } from './file-work.js'
import { flog } from './flog.js'
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
  ack?: Partial<Omit<AckInputs, 'message' | 'workdir' | 'signal'>> & { bare?: boolean; earlier?: readonly Turn[] }
  now?: boolean
  reply?: boolean
  plainAsk?: boolean
  company?: boolean
  remembered?: readonly string[]
  shared?: readonly string[]
  earlierOutputs?: readonly { name: string; path: string }[]
  context?(): string
  skills?(): Promise<NonNullable<LoopOptions['skills']>>
  warm?(): void
  searched?(found?: { query: string; found: string }): void
  onToken?(text: string, held: boolean): void
  onReset?(drop?: boolean, tool?: string): void
  onStep?(line: string): void
}

export interface Answered { trace: AnswerTrace; result?: AgentLoopResult; failure?: unknown; kind?: ReturnType<typeof deskKind> }

export interface Answering {
  run(options?: Omit<AnswerOptions, 'signal' | 'ack'>): Promise<Answered>
  end(): void
}

const laneChanges = new Map<string, (said: string) => void>()
export const laneChanged = (channel: string, said: string): void => laneChanges.get(channel)?.(said)
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
  const { signal, ack: { bare, earlier, ...asked } = {} } = options
  const started = performance.now()
  const ms = () => Math.round(performance.now() - started)
  const trace: AnswerTrace = { message, steps: [], final: { text: '', ms: 0 }, end: 'done' }
  const channel = asked.channel ?? `bot-${botId}`
  const korean = asked.korean ?? threadKorean(message, world.history)
  const turn = signal ?? new AbortController().signal
  beginFirstLine({
    interactive: true, studying: false, limited: false, followUp: false, secret: false, engine: async () => engine, fallback: said => fallbackLine(message, korean, said),
    ...(bare ? {} : fastLane(message, true) ? { line: laneFirstLine(message, korean) } : { told: onlyTells(message, lastReplyOf(earlier ?? world.history)), whole: quickQuestion(message) }),
    ...asked,
    channel, message, korean, workdir: engineCwd(paths), signal: turn,
    show: line => { trace.first ??= { text: line, ms: ms() }; asked.show?.(line) },
  })
  firstLineReady(channel)
  const run = async (options: Omit<AnswerOptions, 'signal' | 'ack'> = {}): Promise<Answered> => {
    const { takeSteer, tools, imagePaths, context, onToken, onReset, onStep, now, reply, plainAsk = engine.id === 'claude', company = false, remembered = [], shared = [], earlierOutputs = [], skills, warm, searched: onSearched, native, ...loop } = options
    let streamed = '', firstLine = false, result: AgentLoopResult | undefined, failure: unknown
    const routed = routeAsk(message, world.history)
    const meant = askNow(message, world.history)
    const everyTool = tools ?? worldTools(world, message, signal)
    const lane = !company && fastLane(routed, plainAsk) && everyTool.some(tool => tool.name === 'search_web')
    const kind = !company && !lane && deskLane(routed, plainAsk) ? deskKind(routed) : undefined
    try {
      const short = kind === 'ask' || kind === 'question'
      const laneNote = company ? '' : lane ? `${LANE_NOTE} ${laneToday(message)}` : !plainAsk ? '' : plainReply(message) ? SMALL_TALK_NOTE : short ? SHORT_QUESTION_NOTE : onlyTells(message) ? TOLD_NOTE : ''
      if (lane) flog('chat-phase', JSON.stringify({ channel, phase: 'fast-lane' }))
      if (lane) warm?.()
      const desk = !!kind, deskMenu = kind && DESK_TOOLS[kind]
      const given = kind === 'note' || kind === 'file' ? await namedText(meant, { workspace: paths.workspace, closed: [paths.cache, paths.privateDir] }, path => namedBy(meant, path)) : undefined
      const deskNote = desk && !short ? [DESK_NOTE, given ? fileGiven(given) : ''].filter(Boolean).join('\n\n') : ''
      const changedNote = meant !== message ? `What the person asks for now: ${meant}` : ''
      if (given) flog('chat-phase', JSON.stringify({ channel, phase: 'desk-preread', bytes: given.text.length }))
      if (desk) flog('chat-phase', JSON.stringify({ channel, phase: 'desk-lane', kind }))
      const fix = kind === 'keep' ? keptFix(message, remembered) : undefined
      const fixArgs = fix ? { facts: [fix.fact], replaces: [fix.old], scope: shared.includes(fix.old) ? 'everyone' : 'this bot' } : undefined
      const fixed = fix && fixArgs ? await everyTool.find(tool => tool.name === 'keep_in_mind')?.run(fixArgs, { task: message, signal }).then(() => fix.answer, (error: unknown) => { flog('comet-memory', error); return undefined }) : undefined
      if (fixed) { firstLineSpoke(channel); flog('chat-phase', JSON.stringify({ channel, phase: 'kept-fix' })) }
      const keep = !fixed && kind === 'keep' ? plainKeep(message, lastReplyOf(world.history), korean) : undefined
      const keepArgs = keep ? { facts: [keep.fact] } : undefined
      const keptPlain = keep && keepArgs ? await everyTool.find(tool => tool.name === 'keep_in_mind')?.run(keepArgs, { task: message, signal }).then(() => keep.answer, (error: unknown) => { flog('comet-memory', error); return undefined }) : undefined
      if (keptPlain) { firstLineSpoke(channel); flog('chat-phase', JSON.stringify({ channel, phase: 'kept-plain' })) }
      const retitle = kind === 'deck' ? slideTitleFix(message) : undefined
      const decks = retitle ? earlierOutputs.filter(output => /\.pptx$/i.test(output.name)) : []
      const retitled = retitle && decks.length === 1 && (!retitle.file || retitle.file === decks[0]!.name) ? await fixSlideTitle(retitle, decks[0]!, everyTool, { task: message, ...(signal ? { signal } : {}) }, korean) : undefined
      if (retitled) { firstLineSpoke(channel); flog('chat-phase', JSON.stringify({ channel, phase: 'slide-fix' })) }
      const sorted = kind === 'tidy' && korean ? await sortByKind(message, paths.workspace, everyTool.find(tool => tool.name === 'file_move'), { task: message, ...(signal ? { signal } : {}) }) : undefined
      if (sorted) { firstLineSpoke(channel); flog('chat-phase', JSON.stringify({ channel, phase: 'kind-sort', moved: (sorted.steps[0]!.args['moves'] as unknown[]).length })) }
      const laneRead: string[] = [], solo = lane && !teamAsk(message)
      const laneTools = lane ? everyTool.filter(tool => LANE_TOOLS.has(tool.name)).map(tool => keepRead(skipWalls(tool), laneRead)) : undefined
      const lookup = swapRounds(message, turn), laneSearch = laneTools?.find(tool => tool.name === 'search_web')
      if (solo && !fixed) laneChanges.set(channel, said => {
        if (!lookup.change(said)) return
        takeSteer?.()
      })
      const searchFor = async (ask: string, within: AbortSignal): Promise<Awaited<ReturnType<typeof firstSearch>>> => {
        const found = await firstSearch(ask, laneSearch, within)
        flog('chat-phase', JSON.stringify({ channel, phase: 'lane-first-search', ran: !!found.opening }))
        onSearched?.(found.query ? { query: found.query, found: found.found ?? '' } : undefined)
        return found
      }
      const searchFirst = solo && routed === message && !fixed
      let searched: Awaited<ReturnType<typeof firstSearch>> | undefined
      onSearched?.()
      const host: AgentLoopResult | undefined = fixed ? { answer: fixed, steps: [{ tool: 'keep_in_mind', args: fixArgs!, observation: 'Kept 1 for later conversations.' }], fellBack: false }
        : keptPlain ? { answer: keptPlain, steps: [{ tool: 'keep_in_mind', args: keepArgs!, observation: 'Kept 1 for later conversations.' }], fellBack: false }
        : retitled ? { ...retitled, fellBack: false } : sorted ? { ...sorted, fellBack: false } : undefined
      if (!host && now) firstLineNow(channel, message, korean)
      const talked = host || reply === false ? undefined : await smallTalkAnswer(channel)
      const note = firstLineNote(channel)
      const shortlist = host || talked || !skills ? undefined : lane ? [] : await skills()
      const lead = (ask: string, within: AbortSignal, more: Partial<LoopOptions> = {}): Promise<AgentLoopResult> => { const notes = [context?.(), laneNote, searched?.opening, deskNote, changedNote, note].filter(Boolean).join('\n\n'); return runComet({ engine, workdir: engineCwd(paths), tools: lane ? laneTools! : deskMenu ? closingBuilds(everyTool.filter(tool => deskMenu.has(tool.name))) : everyTool, ...(imagePaths ? { imagePaths } : {}) }, ask, {
        guided: false,
        session: botId,
        history: world.history,
        ...loop,
        ...(shortlist ? { skills: shortlist } : {}),
        ...(lane ? { modelHint: 'smart' as const, lookup: true, ...(solo ? { deadlineMs: LANE_SOLO_SOFT_MS } : { maxCalls: LANE_TEAM_CALLS }) } : {}),
        ...([SHORT_QUESTION_NOTE, SMALL_TALK_NOTE, TOLD_NOTE].includes(laneNote) ? { short: true } : {}),
        ...(desk ? { modelHint: 'smart' as const, ...(deskLight(kind, routed, { given: !!given, made: earlierOutputs.some(output => /\.(pptx|docx|xlsx)$/i.test(output.name)) }) ? { light: true } : {}) } : {}),
        ...(native && !lane ? { native } : {}),
        ...more,
        signal: within,
        ...(takeSteer ? { takeSteer } : {}),
        ...(notes ? { attachmentContext: notes } : {}),
        onStep: line => { trace.steps.push({ line, ms: ms() }); onStep?.(line) },
        onToken: text => {
          const hold = lane || !!firstLineNote(channel)
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
      result = host ?? (talked ? { answer: talked, steps: [], fellBack: false } : await lookup.run(async (laneAsk, roundSignal, again) => {
        if (again) flog('chat-phase', JSON.stringify({ channel, phase: 'lane-swap', ms: ms() }))
        if (again || searchFirst) searched = await searchFor(laneAsk, roundSignal)
        return lead(laneAsk, roundSignal, solo ? { maxCalls: searched?.calls ?? LANE_SOLO_CALLS } : {})
      }))
      if (lane && !result.asked && result.stopped === 'calls' && !result.incomplete) delete result.stopped
      trace.final = { text: result.answer, ms: ms() }
    } catch (cause) {
      failure = cause
      trace.final = { text: streamed, ms: ms() }
      trace.error = cause instanceof Error ? cause.message : String(cause)
    }
    laneChanges.delete(channel)
    if (!trace.first && trace.final.text.trim()) trace.first = { text: trace.final.text.trim().split('\n')[0]!, ms: trace.final.ms }
    if (signal?.aborted) trace.end = 'stop'
    world.history.push({ role: 'user', text: message }, { role: 'assistant', text: trace.final.text })
    return { trace, ...(result ? { result } : { failure }), ...(kind ? { kind } : {}) }
  }
  return { run, end: () => endFirstLine(channel) }
}
