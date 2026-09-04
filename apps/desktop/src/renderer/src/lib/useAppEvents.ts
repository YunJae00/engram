import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type {
  AbsorbStatusDto,
  BrainFabricDto,
  EngineStatusDto,
  EngramEvent,
  NoteDto,
} from '../../../shared/types.js'
import { api } from '../api.js'
import type { Translate } from '../i18n.js'
import type { AppState, SweepStatus } from '../state-types.js'

type Setter<T> = Dispatch<SetStateAction<T>>

interface EventSetters {
  absorb: Setter<AbsorbStatusDto>
  engines: Setter<EngineStatusDto[]>
  enginesDetected: Setter<boolean>
  errand: Setter<AppState['errand']>
  errandWall: Setter<AppState['errandWall']>
  fabric: Setter<BrainFabricDto>
  filing: Setter<boolean>
  pressAsks: Setter<AppState['pressAsks']>
  routine: Setter<AppState['routine']>
  routineSubmit: Setter<AppState['routineSubmit']>
  routineWall: Setter<AppState['routineWall']>
  sweepJob: Setter<AppState['sweepJob']>
  sweepStartedAt: Setter<number | null>
  sweepStatus: Setter<SweepStatus>
  vaultError: Setter<AppState['vaultError']>
  vaultReady: Setter<boolean>
}

interface AppEventsOptions {
  absorbResetRef: MutableRefObject<number | null>
  cardsInboxTimer: MutableRefObject<number | null>
  latest: MutableRefObject<{ t: Translate; showToast(message: string): void }>
  notesRef: MutableRefObject<Map<string, NoteDto>>
  pendingTimer: MutableRefObject<number | null>
  publishTimer: MutableRefObject<number | null>
  setters: EventSetters
  wasAbsorbing: MutableRefObject<boolean>
  refresh(): Promise<void>
  refreshCardsInboxSoon(): void
  refreshPendingSoon(): void
  schedulePublish(): void
}

const DESK_NOTICE_KEY = 'engram.deskJournal.noticed'

export function useAppEvents(options: AppEventsOptions): void {
  const {
    absorbResetRef,
    cardsInboxTimer,
    latest,
    notesRef,
    pendingTimer,
    publishTimer,
    setters,
    wasAbsorbing,
    refresh,
    refreshCardsInboxSoon,
    refreshPendingSoon,
    schedulePublish,
  } = options

  useEffect(() => {
    const loadVault = () => {
      setters.vaultReady(true)
      void refresh()
      void api.engines().then(setters.engines)
      void api.enginesDetected().then(setters.enginesDetected).catch(() => undefined)
      void api.brainFabric().then(setters.fabric).catch(() => undefined)
    }

    void api
      .vaultReady()
      .then((ready) => {
        if (!ready) return
        loadVault()
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
      if (event.type === 'vault:ready') loadVault()
      if (event.type === 'vault:error') setters.vaultError({ message: event.message, root: event.root })
      if (event.type === 'vault:changed') refreshCardsInboxSoon()
      if (event.type === 'notes:delta') {
        void api.brainFabric().then(setters.fabric).catch(() => undefined)
        for (const note of event.upserts) notesRef.current.set(note.id, note)
        for (const id of event.removed) notesRef.current.delete(id)
        schedulePublish()
        refreshPendingSoon()
      }
      if (event.type === 'filing:start') setters.filing(true)
      if (event.type === 'filing:done') setters.filing(false)
      if (event.type === 'mcp:autoconnected') {
        latest.current.showToast(latest.current.t('toast.mcpConnected', { targets: event.targets.join(', ') }))
      }
      if (event.type === 'semantic:error') latest.current.showToast(latest.current.t('toast.semanticError'))
      if (event.type === 'sweep:start') {
        setters.sweepStatus({ running: true, kind: 'running' })
        setters.sweepStartedAt(Date.now())
      }
      if (event.type === 'sweep:job') {
        setters.sweepJob({ job: event.job, index: event.index, total: event.total })
      }
      if (event.type === 'sweep:done') {
        setters.sweepStatus({
          running: false,
          kind: 'done',
          executed: event.report.executed,
          skipped: event.report.skipped,
          deferred: event.report.deferred,
          ...(event.report.haltReason ? { haltReason: event.report.haltReason } : {}),
        })
        setters.sweepJob(null)
      }
      if (event.type === 'sweep:error') {
        setters.sweepStatus({ running: false, kind: 'error', message: event.message })
        setters.sweepJob(null)
      }
      if (event.type === 'import:progress') {
        const pending = event.total - event.done
        setters.absorb({ pending, total: event.total })
        if (absorbResetRef.current !== null) {
          window.clearTimeout(absorbResetRef.current)
          absorbResetRef.current = null
        }
        if (pending > 0) {
          wasAbsorbing.current = true
        } else if (event.total > 0) {
          if (wasAbsorbing.current) {
            wasAbsorbing.current = false
            latest.current.showToast(latest.current.t('toast.absorbed'))
          }
          absorbResetRef.current = window.setTimeout(() => {
            setters.absorb((previous) => (previous.pending === 0 ? { pending: 0, total: 0 } : previous))
            absorbResetRef.current = null
          }, 2000)
        }
      }
      if (event.type === 'errand:wall') setters.errandWall({ url: event.url, wall: event.wall })
      if (event.type === 'errand:phase') {
        setters.errandWall(null)
        setters.errand((previous) => {
          const fresh = event.phase === 'plan' && (!previous.running || previous.goal !== event.goal)
          const timeline = fresh ? [] : previous.timeline
          const stamped = timeline.some((step) => step.phase === event.phase)
            ? timeline
            : [...timeline, { phase: event.phase, at: Date.now() }]
          return {
            running: event.phase !== 'done' && event.phase !== 'failed',
            phase: event.phase,
            goal: event.goal,
            queries: event.queries ?? (fresh ? undefined : previous.queries),
            notes: event.notes ?? (fresh ? undefined : previous.notes),
            pages: event.pages ?? (fresh ? undefined : previous.pages),
            points: event.points ?? (fresh ? undefined : previous.points),
            timeline: stamped,
          }
        })
        if (event.phase === 'done') latest.current.showToast(latest.current.t('toast.errandDone'))
        else if (event.phase === 'failed') {
          latest.current.showToast(latest.current.t('toast.errandFailed', { reason: event.error ?? '' }))
        }
      }
      if (event.type === 'routine:wall') setters.routineWall({ wall: event.wall })
      if (event.type === 'press:ask') {
        setters.pressAsks((held) => [
          ...held.filter((ask) => ask.channel !== event.channel),
          { channel: event.channel, words: event.words, host: event.host },
        ])
      }
      if (event.type === 'routine:submit') {
        setters.routineSubmit({
          name: event.name,
          filled: event.filled,
          host: event.host,
          canRemember: event.canRemember,
        })
      }
      if (event.type === 'routine:passed') {
        setters.routine((previous) =>
          previous.running
            ? {
                ...previous,
                steps: [
                  ...previous.steps,
                  { label: latest.current.t('routines.passedAuto', { host: event.host }), at: Date.now() },
                ],
              }
            : previous,
        )
      }
      if (event.type === 'routine:step') {
        setters.routineWall(null)
        setters.routine((previous) => {
          const fresh = event.index === 0 || previous.routineId !== event.routineId
          return {
            running: true,
            routineId: event.routineId,
            name: previous.routineId === event.routineId ? previous.name : undefined,
            step: { index: event.index, total: event.total, label: event.label },
            steps: [...(fresh ? [] : previous.steps), { label: event.label, at: Date.now() }],
          }
        })
      }
      if (event.type === 'routine:logged') {
        setters.routineWall(null)
        setters.routineSubmit(null)
        setters.routine({ running: false, steps: [] })
        if (event.outcome === 'done') {
          latest.current.showToast(
            latest.current.t(event.cardId ? 'toast.routineDoneReview' : 'toast.routineDone', {
              name: event.name,
            }),
          )
        } else if (event.outcome === 'failed') {
          latest.current.showToast(latest.current.t('toast.routineFailed', { reason: event.error ?? '' }))
        }
      }
      if (event.type === 'engines:detected') setters.enginesDetected(true)
      if (event.type === 'engines:changed') setters.engines(event.engines)
      if (event.type === 'engine:health') {
        setters.engines((previous) =>
          previous.map((engine) =>
            engine.id === event.id
              ? { ...engine, healthy: event.healthy, healthReason: event.healthy ? undefined : event.reason }
              : engine,
          ),
        )
      }
    })

    return () => {
      unsub()
      for (const ref of [absorbResetRef, publishTimer, cardsInboxTimer, pendingTimer]) {
        if (ref.current !== null) window.clearTimeout(ref.current)
        ref.current = null
      }
    }
  }, [refresh, refreshCardsInboxSoon, refreshPendingSoon, schedulePublish])
}
