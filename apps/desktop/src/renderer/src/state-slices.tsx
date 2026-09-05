import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { AppState } from './state.js'

type ShellState = Pick<
  AppState,
  | 'activity'
  | 'setActivity'
  | 'engines'
  | 'pendingWork'
  | 'toast'
  | 'showToast'
  | 'refresh'
  | 'vaultReady'
  | 'vaultError'
  | 'enginesDetected'
  | 'openNote'
>

type CometState = Pick<
  AppState,
  | 'errand'
  | 'routine'
  | 'startRoutine'
  | 'pressAsks'
  | 'answerPressAsk'
  | 'routineSubmit'
  | 'answerRoutineSubmit'
>

type TopBarState = Pick<
  AppState,
  | 'activity'
  | 'engines'
  | 'sweepStatus'
  | 'filing'
  | 'absorb'
  | 'sweepJob'
  | 'errand'
  | 'errandWall'
  | 'answerErrandWall'
  | 'showToast'
  | 'vaultReady'
>

const ShellCtx = createContext<ShellState | null>(null)
const CometCtx = createContext<CometState | null>(null)
const TopBarCtx = createContext<TopBarState | null>(null)

function required<T>(value: T | null): T {
  if (!value) throw new Error('AppProvider missing')
  return value
}

export function useShellState(): ShellState {
  return required(useContext(ShellCtx))
}

export function useCometState(): CometState {
  return required(useContext(CometCtx))
}

export function useTopBarState(): TopBarState {
  return required(useContext(TopBarCtx))
}

export function StateSlices({ state, children }: { state: AppState; children: ReactNode }) {
  const shell = useMemo<ShellState>(
    () => ({
      activity: state.activity,
      setActivity: state.setActivity,
      engines: state.engines,
      pendingWork: state.pendingWork,
      toast: state.toast,
      showToast: state.showToast,
      refresh: state.refresh,
      vaultReady: state.vaultReady,
      vaultError: state.vaultError,
      enginesDetected: state.enginesDetected,
      openNote: state.openNote,
    }),
    [
      state.activity,
      state.engines,
      state.pendingWork,
      state.toast,
      state.refresh,
      state.vaultReady,
      state.vaultError,
      state.enginesDetected,
      state.openNote,
    ],
  )
  const comet = useMemo<CometState>(
    () => ({
      errand: state.errand,
      routine: state.routine,
      startRoutine: state.startRoutine,
      pressAsks: state.pressAsks,
      answerPressAsk: state.answerPressAsk,
      routineSubmit: state.routineSubmit,
      answerRoutineSubmit: state.answerRoutineSubmit,
    }),
    [
      state.errand,
      state.routine,
      state.startRoutine,
      state.pressAsks,
      state.answerPressAsk,
      state.routineSubmit,
      state.answerRoutineSubmit,
    ],
  )
  const topBar = useMemo<TopBarState>(
    () => ({
      activity: state.activity,
      engines: state.engines,
      sweepStatus: state.sweepStatus,
      filing: state.filing,
      absorb: state.absorb,
      sweepJob: state.sweepJob,
      errand: state.errand,
      errandWall: state.errandWall,
      answerErrandWall: state.answerErrandWall,
      showToast: state.showToast,
      vaultReady: state.vaultReady,
    }),
    [
      state.activity,
      state.engines,
      state.sweepStatus,
      state.filing,
      state.absorb,
      state.sweepJob,
      state.errand,
      state.errandWall,
      state.answerErrandWall,
      state.vaultReady,
    ],
  )

  return (
    <ShellCtx.Provider value={shell}>
      <TopBarCtx.Provider value={topBar}>
        <CometCtx.Provider value={comet}>{children}</CometCtx.Provider>
      </TopBarCtx.Provider>
    </ShellCtx.Provider>
  )
}
