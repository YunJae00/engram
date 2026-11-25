import { activationRerank, cometTools, companyStatusTool, hybridMerge, PROFILE_TYPE, scheduleTool, staffTool, teamTool, toRetrievedNote, type AgentTool, type CometToolDeps, type Note, type NoteStore, type ScheduleDeps, type SemanticHit, type VaultPaths, type WebCourier } from 'core'
import { availableMemory } from './available-memory.js'
import { cometFileTools, type FileHost, type ReadConsent } from './file-work.js'
import { learningTools } from './learning-wiring.js'
import { ROOM_FOR_EMBEDDER } from './memory-plan.js'
import { officeBuildTools, type OfficeOutputs, type Proofread } from './office-agent.js'

export interface ToolKitInputs {
  paths: VaultPaths
  channel: string
  courier: WebCourier | null
  retrieve: CometToolDeps['retrieve']
  log(tag: string, detail: unknown): void
  web?: Omit<CometToolDeps, 'paths' | 'courier' | 'retrieve' | 'onMetric'>
  bot?: { schedule: ScheduleDeps; chief: boolean; changed(): void; said(): string; kept?(added: number): void }
  files?: { readable: string[]; workFolder: string; consent: ReadConsent; host: FileHost }
  office?: { outputs: OfficeOutputs; personal: string; assertActive(): void; proofread?: Proofread }
}

export interface ToolKit {
  web: AgentTool[]
  team: AgentTool[]
  learning: AgentTool[]
  files: AgentTool[]
  office: AgentTool[]
}

export function toolKit(inputs: ToolKitInputs): ToolKit {
  const { paths, channel, bot, files, office } = inputs
  return {
    web: cometTools({ ...inputs.web, paths, courier: inputs.courier, retrieve: inputs.retrieve, onMetric: metric => inputs.log('harness', JSON.stringify({ ...metric, channel })) }),
    team: bot ? [scheduleTool(bot.schedule), ...(bot.chief ? [staffTool(paths, bot.changed), companyStatusTool(paths)] : [teamTool(paths, bot.changed)])] : [],
    learning: bot ? learningTools(paths, channel, bot.said, bot.kept) : [],
    files: files ? cometFileTools(paths, channel, files.readable, [files.workFolder], files.consent, files.host) : [],
    office: office ? officeBuildTools(office.outputs, office.personal, office.assertActive, office.proofread) : [],
  }
}

export type MeaningSearch = (query: string, limit: number) => Promise<SemanticHit[]>

export function noteSearch(store: NoteStore, meaning: { full: MeaningSearch; live: MeaningSearch }, log: (tag: string, detail: unknown) => void): CometToolDeps['retrieve'] {
  return async (query, limit) => {
    const semantic =
      availableMemory() > ROOM_FOR_EMBEDDER
        ? await meaning.full(query, limit)
        : await meaning.live(query, limit)
    const closeness = new Map(semantic.map((one) => [one.id, one.score]))
    log(
      'comet-retrieve',
      `"${query.slice(0, 40)}" free=${(availableMemory() / 1e9).toFixed(1)}GB byMeaning=${semantic.length}${semantic[0] ? ` top=${semantic[0].score.toFixed(2)}` : ''}`,
    )
    const hits = activationRerank(
      hybridMerge(store.search(query), semantic, limit),
      (id) => store.get(id),
    )
    return hits
      .map((h) => store.get(h.id))
      .filter((n): n is Note => n !== null && n.front.status === 'current' && n.front.type !== 'routine' && n.front.type !== PROFILE_TYPE)
      .slice(0, limit)
      .map((note) => ({ ...toRetrievedNote(note), meaning: closeness.get(note.front.id) ?? 0 }))
  }
}
