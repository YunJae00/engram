import { expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  engineStates: vi.fn(async () => [{ id: 'claude', loggedIn: true }, { id: 'codex', loggedIn: true }, { id: 'other', loggedIn: false }]),
  devUsage: vi.fn(async (provider: string) => ({ windows: [{ name: provider, used: 25 }], updatedAt: Date.now() })),
}))
vi.mock('../src/renderer/src/api.js', () => ({ api: fake }))
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }))
import { refreshAccountUsage, useAccountUsage } from '../src/renderer/src/lib/accountUsage.js'

it('coalesces concurrent account requests, caches all connections and removes disconnected accounts', async () => {
  const first = refreshAccountUsage()
  expect(refreshAccountUsage()).toBe(first)
  await first
  expect(fake.devUsage.mock.calls.map(([provider]) => provider)).toEqual(['claude', 'codex'])
  expect(useAccountUsage().map(account => account.loading)).toEqual([false, false])
  await refreshAccountUsage()
  expect(fake.devUsage).toHaveBeenCalledTimes(2)
  fake.engineStates.mockResolvedValueOnce([{ id: 'codex', loggedIn: true }])
  await refreshAccountUsage(true)
  expect(useAccountUsage().map(account => account.provider)).toEqual(['codex'])
})
