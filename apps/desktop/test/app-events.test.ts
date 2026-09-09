import { afterEach, expect, it, vi } from 'vitest'
import type { EngramEvent } from '../src/shared/types.js'
import { t } from '../src/renderer/src/i18n.js'

const fake = vi.hoisted(() => ({
  effect: undefined as (() => (() => void)) | undefined,
  event: undefined as ((event: EngramEvent) => void) | undefined,
  api: {
    vaultReady: vi.fn(async () => false),
    brainFabric: vi.fn(async () => ({ edges: [] })),
    onEvent: vi.fn(),
  },
}))
vi.mock('react', () => ({ useEffect: (effect: () => (() => void)) => { fake.effect = effect } }))
vi.mock('../src/renderer/src/api.js', () => ({ api: fake.api }))
import { useAppEvents } from '../src/renderer/src/lib/useAppEvents.js'

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('coalesces graph refreshes during note bursts and cancels them on unmount', async () => {
  vi.useFakeTimers()
  fake.api.onEvent.mockImplementation((event: (event: EngramEvent) => void) => {
    fake.event = event
    return () => {}
  })
  const options: Parameters<typeof useAppEvents>[0] = {
    absorbResetRef: { current: null }, cardsInboxTimer: { current: null },
    pendingTimer: { current: null }, publishTimer: { current: null },
    latest: { current: { t, showToast: vi.fn() } }, notesRef: { current: new Map() },
    wasAbsorbing: { current: false }, refresh: vi.fn(async () => {}),
    refreshCardsInboxSoon: vi.fn(), refreshPendingSoon: vi.fn(), schedulePublish: vi.fn(),
    setters: {
      absorb: vi.fn(), engines: vi.fn(), enginesDetected: vi.fn(), errand: vi.fn(),
      errandWall: vi.fn(), fabric: vi.fn(), filing: vi.fn(), pressAsks: vi.fn(),
      routine: vi.fn(), routineSubmit: vi.fn(), routineWall: vi.fn(), sweepJob: vi.fn(),
      sweepStartedAt: vi.fn(), sweepStatus: vi.fn(), vaultError: vi.fn(), vaultReady: vi.fn(),
    },
  }
  useAppEvents(options)
  const cleanup = fake.effect!()
  const delta = () => fake.event!({ type: 'notes:delta', upserts: [], removed: [] })
  for (let i = 0; i < 100; i++) delta()
  expect(fake.api.brainFabric).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(200)
  expect(fake.api.brainFabric).toHaveBeenCalledOnce()
  expect(options.setters.fabric).toHaveBeenCalledWith({ edges: [] })
  delta()
  await vi.advanceTimersByTimeAsync(200)
  expect(fake.api.brainFabric).toHaveBeenCalledTimes(2)
  delta()
  cleanup()
  await vi.advanceTimersByTimeAsync(200)
  expect(fake.api.brainFabric).toHaveBeenCalledTimes(2)
})
