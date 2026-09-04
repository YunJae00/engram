import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AbsorbStatusDto, CardDto, EngineStatusDto, InboxDto, NoteDto, PendingWorkDto, BrainFabricDto } from '../../shared/types.js'
import { api } from './api.js'
import { t } from './i18n.js'
import { useAppEvents } from './lib/useAppEvents.js'
import { StateSlices } from './state-slices.js'
import type { Activity, AppState, SweepStatus } from './state-types.js'

export type { AppState, SweepStatus } from './state-types.js'

const Ctx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const value = useContext(Ctx)
  if (!value) throw new Error('AppProvider missing')
  return value
}

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

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

  useAppEvents({
    absorbResetRef,
    cardsInboxTimer,
    latest,
    notesRef,
    pendingTimer,
    publishTimer,
    wasAbsorbing,
    refresh,
    refreshCardsInboxSoon,
    refreshPendingSoon,
    schedulePublish,
    setters: {
      absorb: setAbsorb,
      engines: setEngines,
      enginesDetected: setEnginesDetected,
      errand: setErrand,
      errandWall: setErrandWall,
      fabric: setFabric,
      filing: setFiling,
      pressAsks: setPressAsks,
      routine: setRoutine,
      routineSubmit: setRoutineSubmit,
      routineWall: setRoutineWall,
      sweepJob: setSweepJob,
      sweepStartedAt: setSweepStartedAt,
      sweepStatus: setSweepStatus,
      vaultError: setVaultError,
      vaultReady: setVaultReady,
    },
  })

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

  const openNote = useCallback((id: string) => setSheetNoteId(id), [])
  const closeNote = useCallback(() => setSheetNoteId(null), [])
  const openReview = useCallback(() => setReviewOpen(true), [])
  const closeReview = useCallback(() => setReviewOpen(false), [])
  const openInbox = useCallback(() => setInboxOpen(true), [])
  const closeInbox = useCallback(() => setInboxOpen(false), [])

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
      openNote,
      closeNote,
      reviewOpen,
      openReview,
      closeReview,
      inboxOpen,
      openInbox,
      closeInbox,
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
    [activity, theme, vaultReady, vaultError, enginesDetected, fabric, notes, cards, inbox, engines, refresh, sheetNoteId, openNote, closeNote, reviewOpen, openReview, closeReview, inboxOpen, openInbox, closeInbox, selectedCardId, sweepStatus, filing, absorb, pendingWork, sweepJob, sweepStartedAt, runSweep, errand, errandWall, answerErrandWall, startErrand, routine, routineWall, answerRoutineWall, routineSubmit, answerRoutineSubmit, pressAsks, answerPressAsk, startRoutine, toast, showToast],
  )

  return (
    <StateSlices state={value}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </StateSlices>
  )
}
