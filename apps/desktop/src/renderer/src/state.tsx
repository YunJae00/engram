import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AbsorbStatusDto, CardDto, EngineStatusDto, InboxDto, NoteDto, PendingWorkDto, BrainFabricDto, RoutineBlockDto, EngramEvent } from '../../shared/types.js'
import { api } from './api.js'
import { t, type Translate } from './i18n.js'

type Activity = 'bots' | 'sky' | 'list'

// Sweep status is stored as data (not a pre-translated string) so the label can
// re-render in the active language; the error message comes verbatim from main.
export type SweepStatus =
  | { running: boolean; kind: 'idle' }
  | { running: boolean; kind: 'running' }
  // `deferred` and `haltReason` come straight off the report main already
  // broadcasts and nothing read: without them a sweep that filed nothing
  // because the AI hit its limit rendered as filing having finished.
  | { running: boolean; kind: 'done'; executed: number; skipped: number; deferred: number; haltReason?: 'quota' | 'auth' }
  | { running: boolean; kind: 'error'; message: string }

interface AppState {
  activity: Activity
  setActivity(a: Activity): void
  // follows the OS — no manual toggle
  theme: 'light' | 'dark'
  // false while a (possibly huge) vault is still being read at boot — the
  // shell shows an opening state instead of misleading empty views.
  vaultReady: boolean
  // Set when opening the vault failed for good. Distinct from `!vaultReady`,
  // which only means "not yet" — the shell must not show an opening state for
  // something that is never going to open.
  vaultError: { message: string; root: string } | null
  // false until the first engine detection finishes. Detection spawns two CLI
  // subprocesses (~3.6s measured), so between the shell painting and that
  // answer the honest state is "still looking" — surfaces must not read an
  // empty engine list as "no engine" during that window.
  enginesDetected: boolean
  // What the vault has been told about names (workspace/aliases.md). The
  // Brain groups topics with it so it and the librarian agree; empty means
  // "guess cautiously", which is the behaviour that shipped before.
  fabric: BrainFabricDto
  notes: NoteDto[]
  cards: CardDto[]
  inbox: InboxDto
  engines: EngineStatusDto[]
  // Open most urgent first — the Today sheet lists them and the top-bar
  // Today button counts the ones that want something now. Shared because both
  refresh(): Promise<void>
  // overlays
  sheetNoteId: string | null
  openNote(id: string): void
  closeNote(): void
  reviewOpen: boolean
  openReview(): void
  closeReview(): void
  inboxOpen: boolean
  openInbox(): void
  closeInbox(): void
  // Today sheet: right-side slide-over holding the latest brief + activity feed.
  selectedCardId: string | null
  selectCard(id: string | null): void
  sweepStatus: SweepStatus
  // Realtime capture pipeline (J1) in flight — the "filing your capture" state
  // shown by the top bar and the scrap pile while a capture becomes a note.
  filing: boolean
  // Live librarian progress (single source; TopBar + AbsorbWidget both read it).
  // Absorb queue counts, the current sweep job/step, and the epoch-ms the active
  // sweep:start fired (for the widget's elapsed ticker).
  absorb: AbsorbStatusDto
  // What the librarian hasn't seen yet (inbox + unswept notes) — the badge.
  pendingWork: PendingWorkDto
  sweepJob: { job: string; index: number; total: number } | null
  sweepStartedAt: number | null
  runSweep(): Promise<void>
  // A delegated errand in flight — the top bar narrates its phase; the toast
  // fires on done/failed. `running` gates a second delegation and the progress line.
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
  // A page the errand cannot pass without its human (login/captcha) — the run
  // is parked until errandWall answers.
  errandWall: { url: string; wall: 'login' | 'captcha' } | null
  answerErrandWall: (verdict: 'resolved' | 'skip') => void
  startErrand(goal: string, botId?: string): Promise<void>
  // A routine replay in flight — deterministic saved steps, no model. Held
  // here so the sheet can close and reopen mid-run without losing the story.
  routine: {
    running: boolean
    routineId?: string
    name?: string
    step?: { index: number; total: number; label: string }
    steps: { label: string; at: number }[]
  }
  routineWall: { wall: 'login' | 'captcha' } | null
  answerRoutineWall(verdict: 'resolved' | 'skip'): void
  // What a procedure is about to post, waiting for a yes. Nothing is
  // submitted while this stands.
  routineSubmit: { name: string; filled: { label: string; text: string }[]; host: string | null; canRemember: boolean } | null
  answerRoutineSubmit(verdict: 'approve' | 'always' | 'cancel'): void
  // A comet is at a control that would commit; the person answers with the
  // page in front of them.
  // Every comet standing at a control that would commit, each waiting for
  // its own answer.
  pressAsks: { channel: string; words: string; host: string | null }[]
  answerPressAsk(channel: string, verdict: 'approve' | 'always' | 'cancel'): void
  // Resolves with the refusal so a caller can ask the rerun question itself.
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

const Ctx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const value = useContext(Ctx)
  if (!value) throw new Error('AppProvider missing')
  return value
}

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// Set once the Today sheet has been shown (auto-revealed after the first brief
// or opened by hand) — the one-time reveal must never fire twice.
// One-time disclosure that the desk journal records by default — the privacy
// promise is that the user knows what is being read.
const DESK_NOTICE_KEY = 'engram.deskJournal.noticed'

export function AppProvider({ children }: { children: ReactNode }) {
  const [activity, setActivity] = useState<Activity>('bots')
  const [theme, setTheme] = useState<'light' | 'dark'>(systemTheme())
  const [vaultReady, setVaultReady] = useState(false)
  const [vaultError, setVaultError] = useState<{ message: string; root: string } | null>(null)

  // live OS theme follow
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setTheme(media.matches ? 'dark' : 'light')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  // Notes live in a ref Map keyed by id and mutated by notes:delta events; the
  // public `notes` array is a derived, id-sorted snapshot republished on every
  // change (same order as core's NoteStore.getAll — by id).
  const notesRef = useRef<Map<string, NoteDto>>(new Map())
  const [notes, setNotes] = useState<NoteDto[]>([])
  // Publishing the notes array re-renders everything under the provider, so
  // it happens only when the notes actually changed: a background ping that
  // read the same list back must not cost the whole window a render while
  // the person is typing or scrolling.
  const notesSignature = useRef('')
  const publishNotes = useCallback(() => {
    const sorted = [...notesRef.current.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const signature = sorted.map((n) => `${n.id}:${n.updated}:${n.status}:${n.badge}`).join('|')
    if (signature === notesSignature.current) return
    notesSignature.current = signature
    setNotes(sorted)
  }, [])
  const publishTimer = useRef<number | null>(null)
  const schedulePublish = useCallback(() => {
    if (publishTimer.current !== null) return
    publishTimer.current = window.setTimeout(() => {
      publishTimer.current = null
      publishNotes()
    }, 200)
  }, [publishNotes])
  const [cards, setCards] = useState<CardDto[]>([])
  const [inbox, setInbox] = useState<InboxDto>({ files: [], failures: [] })
  const [engines, setEngines] = useState<EngineStatusDto[]>([])
  const [enginesDetected, setEnginesDetected] = useState(false)
  const [fabric, setFabric] = useState<BrainFabricDto>({ edges: [] })
  const [sheetNoteId, setSheetNoteId] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [inboxOpen, setInboxOpen] = useState(false)
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [sweepStatus, setSweepStatus] = useState<SweepStatus>({ running: false, kind: 'idle' })
  const [filing, setFiling] = useState(false)
  const [absorb, setAbsorb] = useState<AbsorbStatusDto>({ pending: 0, total: 0 })
  const [pendingWork, setPendingWork] = useState<PendingWorkDto>({ inbox: 0, notes: 0, filing: false })
  const [sweepJob, setSweepJob] = useState<{ job: string; index: number; total: number } | null>(null)
  const [sweepStartedAt, setSweepStartedAt] = useState<number | null>(null)
  const [errand, setErrand] = useState<AppState['errand']>({ running: false, timeline: [] })
  const [errandWall, setErrandWall] = useState<{ url: string; wall: 'login' | 'captcha' } | null>(null)
  const [routine, setRoutine] = useState<AppState['routine']>({ running: false, steps: [] })
  const [routineWall, setRoutineWall] = useState<{ wall: 'login' | 'captcha' } | null>(null)
  const [routineSubmit, setRoutineSubmit] = useState<AppState['routineSubmit']>(null)
  const [pressAsks, setPressAsks] = useState<AppState['pressAsks']>([])
  const [toast, setToast] = useState<string | null>(null)
  // Fire the "absorbed" toast once per absorbing session, on the pending→0 edge.
  const wasAbsorbing = useRef(false)
  // After a run finishes (pending→0) the 43/43·100% bar lingers as a completion
  // state, then resets so it can't bleed into a later, unrelated sweep.
  const absorbResetRef = useRef<number | null>(null)

  // Full notes resync: authoritative fetch that rebuilds the map from scratch
  // (used on mount and as a window-focus fallback in case a delta was missed).
  const refreshNotes = useCallback(async () => {
    const list = await api.listNotes()
    const map = new Map<string, NoteDto>()
    for (const note of list) map.set(note.id, note)
    notesRef.current = map
    publishNotes()
  }, [publishNotes])

  // vault:changed refreshes cards + inbox + absorb counts — notes arrive via
  // deltas; absorb also updates live from import:progress in the event loop.
  // Open loops ride along here rather than on notes:delta: the librarian is
  // what sets open_loop/due_at, and every librarian write ends in a
  // vault:changed, so this catches them on the already-coalesced path instead
  // of re-scanning the store on every delta of a long sweep.
  const refreshCardsInbox = useCallback(async () => {
    const [nextCards, nextInbox, nextAbsorb, nextPending] = await Promise.all([
      api.listCards(),
      api.inboxList(),
      api.absorbStatus(),
      api.librarianPending(),
    ])
    setCards(nextCards)
    setInbox(nextInbox)
    setAbsorb(nextAbsorb)
    setPendingWork(nextPending)
    // Boot/resync snapshot of the in-flight pipeline: the onboarding first
    // capture starts filing before this window exists, so the live events
    // alone would leave the state stuck at false.
    setFiling(nextPending.filing)
  }, [])

  const refresh = useCallback(async () => {
    await Promise.all([refreshNotes(), refreshCardsInbox()])
  }, [refreshNotes, refreshCardsInbox])

  // vault:changed can fire several times in a burst (per-engine boot ping, each
  // absorb batch, migrations). Each call is three IPC round-trips, so coalesce a
  // burst into one trailing refresh instead of hammering the main process.
  const cardsInboxTimer = useRef<number | null>(null)
  const refreshCardsInboxSoon = useCallback(() => {
    if (cardsInboxTimer.current !== null) window.clearTimeout(cardsInboxTimer.current)
    cardsInboxTimer.current = window.setTimeout(() => {
      cardsInboxTimer.current = null
      void refreshCardsInbox()
    }, 150)
  }, [refreshCardsInbox])

  // Tidy-badge-only refresh (one IPC), debounced — the note-delta path.
  const pendingTimer = useRef<number | null>(null)
  const refreshPendingSoon = useCallback(() => {
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current)
    pendingTimer.current = window.setTimeout(() => {
      pendingTimer.current = null
      void api.librarianPending().then(setPendingWork).catch(() => undefined)
    }, 300)
  }, [])

  // Refetch notes when the window regains focus — a cheap resync that heals any
  // delta dropped while the app was backgrounded. Also re-detect engines here
  // (throttled): a CLI logged in/out out-of-band while the app was in the
  // background gets picked up the moment the user comes back, so the "AI
  // disconnected and I can't get it back" state self-heals without a restart.
  const lastEngineCheck = useRef(0)
  useEffect(() => {
    const onFocus = () => {
      void refreshNotes()
      if (Date.now() - lastEngineCheck.current > 15_000) {
        lastEngineCheck.current = Date.now()
        void api.enginesRefresh().catch(() => undefined)
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshNotes])

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 2500)
  }, [])

  // Keep the freshest t/showToast for the long-lived event handler below so the
  // absorbed toast follows the active language without re-subscribing.
  const latest = useRef({ t, showToast })
  latest.current = { t, showToast }

  // Single subscription to the main-process event stream. Notes arrive as
  // deltas; sweep/absorb progress is mirrored into shared state here so both
  // the TopBar and the floating AbsorbWidget read one source of truth.
  useEffect(() => {
    // Window-first boot: the vault IPC surface may not exist yet (a 100k-note
    // vault reads for seconds). Ask once; if not ready, the vault:ready event
    // below triggers the initial load instead — no failed-call noise.
    void api
      .vaultReady()
      .then((ready) => {
        if (!ready) return
        setVaultReady(true)
        void refresh()
        void api.engines().then(setEngines)
        void api.enginesDetected().then(setEnginesDetected).catch(() => undefined)
        void api.brainFabric().then(setFabric).catch(() => undefined)
        if (localStorage.getItem(DESK_NOTICE_KEY) === null) {
          localStorage.setItem(DESK_NOTICE_KEY, '1')
          void api
            .activityGet()
            .then((on) => {
              if (on) latest.current.showToast(latest.current.t('toast.deskJournalNotice'))
            })
            .catch(() => undefined)
        }
      })
      .catch(() => undefined)
    const unsub = api.onEvent((event: EngramEvent) => {
      if (event.type === 'vault:ready') {
        setVaultReady(true)
        void refresh()
        void api.engines().then(setEngines)
        void api.enginesDetected().then(setEnginesDetected).catch(() => undefined)
        void api.brainFabric().then(setFabric).catch(() => undefined)
      }
      if (event.type === 'vault:error') setVaultError({ message: event.message, root: event.root })
      if (event.type === 'vault:changed') refreshCardsInboxSoon()
      if (event.type === 'notes:delta') {
        void api.brainFabric().then(setFabric).catch(() => undefined)
        for (const note of event.upserts) notesRef.current.set(note.id, note)
        for (const id of event.removed) notesRef.current.delete(id)
        schedulePublish()
        // A human edit arrives as a delta only — keep the Tidy badge live with
        // ONE cheap call. The old path fired the full 4-IPC cards/inbox
        // refresh per delta, which a long sweep re-triggered endlessly;
        // cards/inbox changes always come with a vault:changed anyway.
        refreshPendingSoon()
      }
      if (event.type === 'filing:start') setFiling(true)
      if (event.type === 'filing:done') setFiling(false)
      // Zero-click MCP hookup healed/attached a Claude — say so once.
      if (event.type === 'mcp:autoconnected') showToast(t('toast.mcpConnected', { targets: event.targets.join(', ') }))
      // The semantic layer fell over — search quietly became lexical-only,
      // invisible from results alone. One toast per transition; details in Settings.
      if (event.type === 'semantic:error') showToast(t('toast.semanticError'))
      if (event.type === 'sweep:start') {
        setSweepStatus({ running: true, kind: 'running' })
        setSweepStartedAt(Date.now())
      }
      if (event.type === 'sweep:job') setSweepJob({ job: event.job, index: event.index, total: event.total })
      if (event.type === 'sweep:done') {
        setSweepStatus({
          running: false,
          kind: 'done',
          executed: event.report.executed,
          skipped: event.report.skipped,
          deferred: event.report.deferred,
          ...(event.report.haltReason ? { haltReason: event.report.haltReason } : {}),
        })
        setSweepJob(null)
      }
      if (event.type === 'sweep:error') {
        setSweepStatus({ running: false, kind: 'error', message: event.message })
        setSweepJob(null)
      }
      if (event.type === 'import:progress') {
        const stillPending = event.total - event.done
        setAbsorb({ pending: stillPending, total: event.total })
        // Fresh progress cancels any queued completion reset.
        if (absorbResetRef.current !== null) {
          window.clearTimeout(absorbResetRef.current)
          absorbResetRef.current = null
        }
        if (stillPending > 0) {
          wasAbsorbing.current = true
        } else if (event.total > 0) {
          if (wasAbsorbing.current) {
            wasAbsorbing.current = false
            latest.current.showToast(latest.current.t('toast.absorbed'))
          }
          // Keep the completed bar on screen briefly, then clear it so it never
          // lingers at 100% into a later sweep. The toast stays either way. Guard
          // against a new absorb that started meanwhile (pending>0) — don't wipe it.
          absorbResetRef.current = window.setTimeout(() => {
            setAbsorb((prev) => (prev.pending === 0 ? { pending: 0, total: 0 } : prev))
            absorbResetRef.current = null
          }, 2000)
        }
      }
      // A delegated errand moving through its phases. 'done'/'failed' end the
      // run and speak once; the middle phases just relabel the top-bar line.
      if (event.type === 'errand:wall') setErrandWall({ url: event.url, wall: event.wall })
      if (event.type === 'errand:phase') {
        setErrandWall(null)
        setErrand((prev) => {
          // A new run wipes the last one's timeline; within a run each phase
          // stamps itself once, so the sheet can show how far it got.
          const fresh = event.phase === 'plan' && (!prev.running || prev.goal !== event.goal)
          const timeline = fresh ? [] : prev.timeline
          const stamped = timeline.some((step) => step.phase === event.phase)
            ? timeline
            : [...timeline, { phase: event.phase, at: Date.now() }]
          return {
            running: event.phase !== 'done' && event.phase !== 'failed',
            phase: event.phase,
            goal: event.goal,
            queries: event.queries ?? (fresh ? undefined : prev.queries),
            notes: event.notes ?? (fresh ? undefined : prev.notes),
            pages: event.pages ?? (fresh ? undefined : prev.pages),
            points: event.points ?? (fresh ? undefined : prev.points),
            timeline: stamped,
          }
        })
        if (event.phase === 'done') latest.current.showToast(latest.current.t('toast.errandDone'))
        else if (event.phase === 'failed')
          latest.current.showToast(latest.current.t('toast.errandFailed', { reason: event.error ?? '' }))
      }
      // A routine replay narrating its steps. The logged event ends the run
      // and speaks once — with a door to review when a reading landed.
      if (event.type === 'routine:wall') setRoutineWall({ wall: event.wall })
      if (event.type === 'press:ask')
        setPressAsks((held) => [...held.filter((ask) => ask.channel !== event.channel), { channel: event.channel, words: event.words, host: event.host }])
      if (event.type === 'routine:submit')
        setRoutineSubmit({ name: event.name, filled: event.filled, host: event.host, canRemember: event.canRemember })
      if (event.type === 'routine:passed')
        setRoutine((prev) =>
          prev.running
            ? { ...prev, steps: [...prev.steps, { label: latest.current.t('routines.passedAuto', { host: event.host }), at: Date.now() }] }
            : prev,
        )
      if (event.type === 'routine:step') {
        setRoutineWall(null)
        setRoutine((prev) => {
          const fresh = event.index === 0 || prev.routineId !== event.routineId
          return {
            running: true,
            routineId: event.routineId,
            name: prev.routineId === event.routineId ? prev.name : undefined,
            step: { index: event.index, total: event.total, label: event.label },
            steps: [...(fresh ? [] : prev.steps), { label: event.label, at: Date.now() }],
          }
        })
      }
      if (event.type === 'routine:logged') {
        setRoutineWall(null)
        setRoutineSubmit(null)
        setRoutine({ running: false, steps: [] })
        if (event.outcome === 'done')
          latest.current.showToast(
            latest.current.t(event.cardId ? 'toast.routineDoneReview' : 'toast.routineDone', { name: event.name }),
          )
        else if (event.outcome === 'failed')
          latest.current.showToast(latest.current.t('toast.routineFailed', { reason: event.error ?? '' }))
      }
      if (event.type === 'engines:detected') setEnginesDetected(true)
      if (event.type === 'engines:changed') setEngines(event.engines)
      // Health is folded into the engine list rather than kept in a second
      // place: the top-bar dot, the banner and Diagnostics all read one array,
      // so they cannot contradict each other, and a renderer reload re-seeds
      // itself from engines:list (which carries the same field).
      if (event.type === 'engine:health') {
        setEngines((prev) =>
          prev.map((engine) =>
            engine.id === event.id
              ? { ...engine, healthy: event.healthy, healthReason: event.healthy ? undefined : event.reason }
              : engine,
          ),
        )
      }
    })
    return () => {
      unsub()
      if (absorbResetRef.current !== null) {
        window.clearTimeout(absorbResetRef.current)
        absorbResetRef.current = null
      }
      if (publishTimer.current !== null) {
        window.clearTimeout(publishTimer.current)
        publishTimer.current = null
      }
      if (cardsInboxTimer.current !== null) {
        window.clearTimeout(cardsInboxTimer.current)
        cardsInboxTimer.current = null
      }
      if (pendingTimer.current !== null) {
        window.clearTimeout(pendingTimer.current)
        pendingTimer.current = null
      }
    }
  }, [refresh, refreshCardsInboxSoon, refreshPendingSoon, schedulePublish])

  const runSweep = useCallback(async () => {
    try {
      await api.sweep()
      await refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message.replace(/^.*Error: /, '') : String(err))
    }
  }, [refresh, showToast])

  const answerErrandWall = useCallback((verdict: 'resolved' | 'skip') => {
    setErrandWall(null)
    void api.errandWallDone(verdict).catch(() => undefined)
  }, [])

  const answerRoutineWall = useCallback((verdict: 'resolved' | 'skip') => {
    setRoutineWall(null)
    void api.routineWallDone(verdict).catch(() => undefined)
  }, [])

  const answerPressAsk = useCallback((channel: string, verdict: 'approve' | 'always' | 'cancel') => {
    setPressAsks((held) => held.filter((ask) => ask.channel !== channel))
    void api.pressAskDone(channel, verdict).catch(() => undefined)
  }, [])

  const answerRoutineSubmit = useCallback((verdict: 'approve' | 'always' | 'cancel') => {
    setRoutineSubmit(null)
    void api.routineSubmitDone(verdict).catch(() => undefined)
  }, [])

  // Kick off a routine replay. main runs it detached and reports back over
  // routine:* events — so this only surfaces the refusal (browser busy, tight).
  const startRoutine = useCallback(
    async (id: string, name: string, force?: boolean, slots?: Record<string, string>) => {
      setRoutine({ running: true, routineId: id, name, steps: [] })
      const result = await api.routineRun(id, force, slots)
      if (!result.ok) {
        setRoutine({ running: false, steps: [] })
        // A refusal that is really a question stays quiet here: a toast would
        // scroll away, and the answer belongs next to the Run button.
        if (!result.blocked) showToast(result.error ?? t('toast.routineFailed', { reason: '' }))
      }
      return result
    },
    [showToast],
  )

  // Kick off a delegated errand. main runs it detached and reports back over
  // errand:phase — so this only surfaces the refusal (no engine, already busy).
  const startErrand = useCallback(
    async (goal: string, botId?: string) => {
      if (!goal.trim()) return
      setErrand({ running: true, goal: goal.trim(), timeline: [] })
      const result = await api.errandStart(goal.trim(), botId)
      if (!result.ok) {
        setErrand({ running: false, timeline: [] })
        showToast(result.error ?? t('toast.errandFailed', { reason: '' }))
      }
    },
    [showToast],
  )

  const value = useMemo<AppState>(
    () => ({
      activity,
      setActivity,
      theme,
      vaultReady,
      vaultError,
      enginesDetected,
      fabric,
      notes,
      cards,
      inbox,
      engines,
      refresh,
      sheetNoteId,
      openNote: (id: string) => setSheetNoteId(id),
      closeNote: () => setSheetNoteId(null),
      reviewOpen,
      openReview: () => setReviewOpen(true),
      closeReview: () => setReviewOpen(false),
      inboxOpen,
      openInbox: () => setInboxOpen(true),
      closeInbox: () => setInboxOpen(false),
      selectedCardId,
      selectCard: setSelectedCardId,
      sweepStatus,
      filing,
      absorb,
      pendingWork,
      sweepJob,
      sweepStartedAt,
      runSweep,
      errand,
      errandWall,
      answerErrandWall,
      startErrand,
      routine,
      routineWall,
      answerRoutineWall,
      routineSubmit,
      answerRoutineSubmit,
      pressAsks,
      answerPressAsk,
      startRoutine,
      toast,
      showToast,
      t,
    }),
    [activity, theme, vaultReady, vaultError, enginesDetected, fabric, notes, cards, inbox, engines, refresh, sheetNoteId, reviewOpen, inboxOpen, selectedCardId, sweepStatus, filing, absorb, pendingWork, sweepJob, sweepStartedAt, runSweep, errand, errandWall, answerErrandWall, startErrand, routine, routineWall, answerRoutineWall, routineSubmit, answerRoutineSubmit, pressAsks, answerPressAsk, startRoutine, toast, showToast],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
