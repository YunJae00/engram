import type {
  AbsorbStatusDto,
  BrainFabricDto,
  CardDto,
  EngineStatusDto,
  InboxDto,
  NoteDto,
  PendingWorkDto,
  RoutineBlockDto,
} from '../../shared/types.js'
import type { Translate } from './i18n.js'

export type Activity = 'bots' | 'sky' | 'list'

export type SweepStatus =
  | { running: boolean; kind: 'idle' }
  | { running: boolean; kind: 'running' }
  | {
      running: boolean
      kind: 'done'
      executed: number
      skipped: number
      deferred: number
      haltReason?: 'quota' | 'auth'
    }
  | { running: boolean; kind: 'error'; message: string }

export interface AppState {
  activity: Activity
  setActivity(a: Activity): void
  theme: 'light' | 'dark'
  vaultReady: boolean
  vaultError: { message: string; root: string } | null
  enginesDetected: boolean
  fabric: BrainFabricDto
  notes: NoteDto[]
  cards: CardDto[]
  inbox: InboxDto
  engines: EngineStatusDto[]
  refresh(): Promise<void>
  sheetNoteId: string | null
  openNote(id: string): void
  closeNote(): void
  reviewOpen: boolean
  openReview(): void
  closeReview(): void
  inboxOpen: boolean
  openInbox(): void
  closeInbox(): void
  selectedCardId: string | null
  selectCard(id: string | null): void
  sweepStatus: SweepStatus
  filing: boolean
  absorb: AbsorbStatusDto
  pendingWork: PendingWorkDto
  sweepJob: { job: string; index: number; total: number } | null
  sweepStartedAt: number | null
  runSweep(): Promise<void>
  errand: {
    running: boolean
    phase?: string
    goal?: string
    queries?: string[]
    notes?: number
    pages?: { url: string; title: string }[]
    points?: number
    timeline: { phase: string; at: number }[]
  }
  errandWall: { url: string; wall: 'login' | 'captcha' } | null
  answerErrandWall(verdict: 'resolved' | 'skip'): void
  startErrand(goal: string, botId?: string): Promise<void>
  routine: {
    running: boolean
    routineId?: string
    name?: string
    step?: { index: number; total: number; label: string }
    steps: { label: string; at: number }[]
  }
  routineWall: { routineId: string; wall: 'login' | 'captcha' } | null
  answerRoutineWall(verdict: 'resolved' | 'skip'): void
  routineSubmit: {
    routineId: string
    name: string
    filled: { label: string; text: string }[]
    host: string | null
    canRemember: boolean
  } | null
  answerRoutineSubmit(verdict: 'approve' | 'always' | 'cancel'): void
  pressAsks: { channel: string; words: string; host: string | null }[]
  answerPressAsk(channel: string, verdict: 'approve' | 'always' | 'cancel'): void
  startRoutine(
    id: string,
    name: string,
    force?: boolean,
    slots?: Record<string, string>,
  ): Promise<{ ok: boolean; blocked?: RoutineBlockDto }>
  toast: string | null
  showToast(message: string): void
  t: Translate
}
