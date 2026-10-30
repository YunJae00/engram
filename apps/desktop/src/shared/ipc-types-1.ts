import type { AppSettingsDto } from './types.js'

export interface McpInfoDto {
  configJson: string
  desktopConfigPath: string
  scriptExists: boolean
}

export interface McpConnectResultDto {
  ok: boolean
  code?: 'not-installed' | 'no-cli' | 'failed'
  detail?: string
}

export interface McpClientDto {
  id: 'claude' | 'codex' | 'desktop'
  state: 'configured' | 'not-configured' | 'unavailable' | 'error'
}

export interface BookmarkDto { title: string; url: string; folder: string; folderPath?: string[]; sourceId?: string; sourceName?: string }

export interface NoteDto {
  id: string
  title: string
  status: 'current' | 'superseded' | 'disputed' | 'draft' | 'archived'
  type: string
  decay: 'evergreen' | 'slow' | 'fast' | 'ephemeral'
  badge: string
  happened_at?: string
  timeline: 'pinned' | 'inferred' | 'ignore'
  owner?: string
  created: string
  updated: string
  supersedes: string[]
  derived_from: string[]
  link_reasons?: Record<string, string>
  source?: string
  context?: string
  last_recalled?: string
  open_loop?: boolean
  activation: number
  excerpt: string
}

export type LoopUrgencyDto = 'overdue' | 'today' | 'this-week' | 'later' | 'no-deadline'

export interface OpenLoopDto {
  id: string
  title: string
  urgency: LoopUrgencyDto
  due_at?: string
  daysUntilDue: number | null
  daysOpen: number
}

export interface CardDto {
  id: string
  cardType: 'new-note' | 'supersede' | 'conflict' | 'stale' | 'merge' | 'chronology'
  targets: string[]
  rationale: string
  proposed: string
  status: 'proposed' | 'approved' | 'rejected' | 'dismissed'
  created: string
}

export interface CardDetailDto {
  card: CardDto
  targets: { id: string; title: string; body: string }[]
}

export interface InboxDto {
  files: { name: string; preview: string }[]
  failures: { kind: string; inputKey: string; error: string }[]
}

export interface MissionFrameDto {
  lane: string
  on: boolean
  url?: string
  data?: string
  at?: number
}

export type EngineHealthReason = 'auth' | 'quota' | 'outage' | 'network' | 'timeout' | 'crash' | 'unknown'

export interface EngineHealthDto {
  healthy: boolean
  reason?: EngineHealthReason
}

export interface ScheduleDto {
  days: number[]
  hour: number
  minute: number
  on?: string
}

export interface BotTaskDto {
  id: string
  name: string
  goal: string
  lastRunAt?: string
  schedule?: ScheduleDto
  routineId?: string
}

export interface BotDto {
  id: string
  name: string
  purpose: string
  createdAt: string
  lastMessage?: { role: 'user' | 'assistant'; text: string; at: string }
  webSites?: { origin: string; visits: number }[]
  tasks?: BotTaskDto[]
}

export interface BotTurnDto {
  role: 'user' | 'assistant'
  text: string
  at: string
  attachments?: string[]
}

export interface BotSuggestionDto {
  name: string
  purpose: string
  reason: string
}

export interface ApprovalRuleDto {
  fingerprint: string
  routineId: string
  host: string
  createdAt: string
}

export interface BotFactDto {
  id: string
  text: string
  at: string
  touchedAt: string
}

export interface RoutineTargetDto {
  css?: string[]
  text?: string
}

export type RoutineStepDto =
  | { kind: 'open'; url: string }
  | { kind: 'click'; target: RoutineTargetDto }
  | { kind: 'type'; target: RoutineTargetDto; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'read' }

export type RoutineBlockDto = 'already-ran-today' | 'unfinished-write'

export interface RoutineDto {
  id: string
  name: string
  steps: RoutineStepDto[]
  task?: { goal: string; urls: string[]; method: string[]; surface: 'web' | 'auto'; context?: string[]; checks?: string[]; execution?: { engine: 'claude' | 'codex'; model: string; effort?: AppSettingsDto['claudeEffort'] } }
  createdAt: string
  lastRunAt?: string
  lastOutcome?: 'done' | 'failed' | 'aborted'
  lastSuccessAt?: string
  posts?: boolean
  pendingWrite?: { at: string; step: number; label: string }
}

export interface ErrandRunDto {
  id: string
  goal: string
  botId?: string
  startedAt: string
  endedAt: string
  outcome: 'done' | 'failed' | 'aborted'
  title?: string
  cardId?: string
  noteSources: number
  pages: { url: string; title: string }[]
  error?: string
}

export interface UpdateCheckDto {
  state: 'current' | 'downloading' | 'ready' | 'available' | 'checking-unavailable' | 'error'
  version?: string
  selfInstalls: boolean
  percent?: number
  message?: string
}

export interface EngineStatusDto {
  id: string
  installed: boolean
  loggedIn: boolean
  conclusive?: boolean
  desktopToolIsolation?: boolean
  healthy?: boolean
  healthReason?: EngineHealthReason
}

export interface ChatTurnDto {
  role: 'user' | 'assistant'
  text: string
  attachments?: string[]
  evidence?: import('core').TurnEvidence
  scheduled?: boolean
}

export interface DelegatedTaskDto {
  id: string
  goal: string
  botId: string
  state: 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
  turns: number
  work?: number
  createdAt: string
  updatedAt: string
  finishedAt?: string
  question?: string
  approvals: { id: string; words: string; host: string; url: string; at: string; answer?: 'approve' | 'decline'; settled?: boolean }[]
  result?: string
  log: { at: string; line: string }[]
}

export interface ChatRequestDto {
  previouslySaid?: boolean
  engineId: string
  message: string
  history: ChatTurnDto[]
  attachments?: string[]
  noteId?: string
  channel?: string
  botId?: string
  scheduled?: boolean
}

export interface ChatAttachmentDto {
  id: string
  name: string
  size: number
}

export interface ChatAttachmentPreviewDto extends ChatAttachmentDto {
  mime?: string
  data?: Uint8Array
  text?: string
  truncated?: boolean
}

export interface SweepReportDto {
  executed: number
  skipped: number
  failed: number
  deferred: number
  briefWritten: boolean
  haltReason?: 'quota' | 'auth' | 'outage'
}

export interface SearchHitDto {
  id: string
  title: string
  status: string
  badge: string
}

export interface MetaPatch {
  type?: string
  decay?: NoteDto['decay']
  happened_at?: string
  owner?: string
  open_loop?: boolean
}

export interface ApproveOptionsDto {
  choice?: 'A' | 'B' | 'both'
  action?: 'keep' | 'retire'
  proposed?: string
}

export interface SyncStatusDto {
  state: 'clean' | 'ahead' | 'behind' | 'diverged' | 'no-remote' | 'error'
  ahead: number
  behind: number
  conflictCards?: number
  remote?: string
}

export interface BrainFabricDto {
  edges: { a: string; b: string; w: number }[]
}
