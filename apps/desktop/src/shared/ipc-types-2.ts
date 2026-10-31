import type { NoteDto, MissionFrameDto, EngineHealthReason, ScheduleDto, UpdateCheckDto, EngineStatusDto, SweepReportDto, AppSettingsDto, FirstSetupDto, EngineLoginDto } from './types.js'
import type { DesktopControlStatusDto } from './desktop.js'
import type { DevUpdate } from './developers.js'

export interface FadingMemoryDto {
  id: string
  title: string
  daysQuiet: number
}

export interface SubjectKnowledgeDto {
  aliases: string[][]
  umbrella: string[]
}

export interface AbsorbStatusDto {
  pending: number
  total: number
}

export interface GithubConnectResultDto {
  ok: boolean
  detail?: string
}

export interface PendingWorkDto {
  inbox: number
  notes: number
  filing: boolean
}

export interface BrowserTabDto { id: string; url: string; title?: string; active: boolean }

export type EngramEvent =
  | { type: 'dev:changed'; update: DevUpdate | null }
  | { type: 'agent:tabs'; lane: string; tabs: BrowserTabDto[] }
  | { type: 'desktop:preview'; frames: import('./desktop.js').WorkPreviewDto[] }
  | { type: 'desktop:changed' }
  | { type: 'desktop:visibility'; visible: boolean }
  | { type: 'desktop:control'; control: DesktopControlStatusDto }
  | { type: 'desktop:pointer'; x: number; y: number; press?: boolean }
  | { type: 'vault:changed' }
  | { type: 'notes:delta'; upserts: NoteDto[]; removed: string[] }
  | { type: 'filing:start' }
  | { type: 'filing:done' }
  | { type: 'mcp:autoconnected'; targets: string[] }
  | { type: 'semantic:error'; detail: string }
  | { type: 'engines:detected' }
  | { type: 'models:changed' }
  | { type: 'accounts:changed'; accounts: import('./account-profiles.js').AccountProfiles }
  | { type: 'engines:login'; login: EngineLoginDto }
  | { type: 'sweep:start' }
  | { type: 'sweep:job'; job: string; index: number; total: number }
  | { type: 'sweep:done'; report: SweepReportDto }
  | { type: 'sweep:error'; message: string }
  | { type: 'chat:token'; channel: string; text: string; reset?: boolean; drop?: boolean }
  | {
      type: 'chat:done'
      channel: string
      text: string
      evidence?: import('core').TurnEvidence

      offer?:
        | { kind: 'run'; routineId: string; name: string; slots?: Record<string, string>; force?: boolean }
        | { kind: 'keep'; name: string; goal: string; does: string }
        | { kind: 'standing'; name: string; goal: string; count: number; schedule: ScheduleDto; routineId: string }
        | { kind: 'asked'; question: string; options: string[] }
    }
  | { type: 'chat:error'; channel: string; message: string; kind?: EngineHealthReason; provider?: string }
  | { type: 'firstSetup:changed'; status: FirstSetupDto }
  | { type: 'agent:live'; on: boolean; url?: string; lane?: string }
  | { type: 'agent:pointer'; x: number; y: number; kind: 'move' | 'press' }
  | { type: 'chat:offer'; channel: string; offer: NonNullable<Extract<EngramEvent, { type: 'chat:done' }>['offer']> }
  | { type: 'chat:steer-returned'; channel: string; texts: string[] }
  | { type: 'chat:steer-unapplied'; channel: string; texts: string[] }
  | { type: 'agent:frame'; data: string; width: number; height: number; url: string; lane: string }
  | { type: 'mission:frame'; frame: MissionFrameDto }
  | { type: 'comet:step'; channel: string; line: string }
  | { type: 'comet:remembered'; channel: string; botId: string; added: number; touched: number }
  | { type: 'bots:changed' }
  | { type: 'tasks:changed' }
  | { type: 'task:notice'; message: string }
  | { type: 'comet:continue'; channel: string; botId: string }
  | { type: 'comet:working'; channel: string; working: boolean }
  | { type: 'comet:observed'; channel: string }
  | {
      type: 'routine:submit'
      routineId: string
      channel?: string
      name: string
      filled: { label: string; text: string }[]
      host: string | null
      canRemember: boolean
    }
  | { type: 'routine:passed'; routineId: string; host: string }
  | { type: 'press:ask'; channel: string; words: string; host: string | null }
  | { type: 'note:open'; id: string }
  | { type: 'comet:open'; botId: string }
  | { type: 'comet:quick'; botId: string; message: string; attachments?: string[] }
  | { type: 'comet:scheduled'; botId: string; message: string }
  | { type: 'brain:setup' }
  | { type: 'settings:changed'; settings: AppSettingsDto }
  | { type: 'habits:changed' }
  | { type: 'notices:changed' }
  | { type: 'study:changed'; botId: string }
  | { type: 'import:progress'; done: number; total: number }
  | { type: 'engines:changed'; engines: EngineStatusDto[] }
  | { type: 'update:changed'; update: UpdateCheckDto }
  | { type: 'engine:health'; id: string; healthy: boolean; reason?: EngineHealthReason }
  | { type: 'window:fullscreen'; value: boolean }
  | { type: 'window:focus'; value: boolean }
  | {
      type: 'errand:phase'
      phase: 'plan' | 'gather' | 'web' | 'distill' | 'compose' | 'done' | 'failed'
      goal: string
      queries?: string[]
      notes?: number
      pages?: { url: string; title: string }[]
      points?: number
      error?: string
    }
  | { type: 'errand:logged' }
  | { type: 'errand:wall'; url: string; wall: 'login' | 'captcha' }
  | { type: 'routine:chat'; routineId: string; botId: string; name: string; message: string }
  | { type: 'routine:step'; routineId: string; channel?: string; index: number; total: number; label: string }
  | { type: 'routine:wall'; routineId: string; channel?: string; wall: 'login' | 'captcha' }
  | { type: 'routine:logged'; routineId: string; channel?: string; name: string; outcome: 'done' | 'failed' | 'aborted'; cardId?: string; error?: string }
  | { type: 'vault:ready' }
  | { type: 'vault:error'; message: string; root: string }

export interface WorkspaceInfoDto {
  id: string
  name: string
  root: string
  kind: 'personal' | 'team'
}

export type AgentInputDto =
  | {
      kind: 'mouse'
      type: 'pressed' | 'released' | 'moved' | 'wheel'
      x: number
      y: number
      button?: 'left' | 'right' | 'middle' | 'none'
      clicks?: number
      modifiers?: number
      deltaX?: number
      deltaY?: number
    }
  | { kind: 'key'; type: 'down' | 'up'; key: string; code: string; keyCode: number; text?: string; modifiers?: number }
  | { kind: 'text'; text: string }

export interface NativeSurfaceDto { lane: string; x: number; y: number; width: number; height: number; clip?: { x: number; y: number; width: number; height: number } }
