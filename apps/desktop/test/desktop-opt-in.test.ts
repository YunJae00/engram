import { expect, it, vi } from 'vitest'
import type { AgentTool } from 'core'
import { desktopOptIn } from '../src/main/desktop-opt-in.js'

function fixture() {
  let enabled = false
  const run = vi.fn(async () => 'App text')
  const rich = vi.fn(async () => ({ text: 'App image' }))
  const tool: AgentTool = { name: 'read_desktop', description: 'Read app', argsSchema: {}, run, runRich: rich }
  const consent = { enabled: vi.fn(async () => enabled), enable: vi.fn(async () => { enabled = true }), ask: vi.fn(async () => 'approve' as 'approve' | 'cancel' | 'later') }
  return { tools: desktopOptIn([tool], consent), consent, run, rich }
}
it('asks before any desktop read, then reuses explicit consent for rich and text calls', async () => {
  const f = fixture()
  await expect(f.tools[0]!.run({}, { task: 'Find my app session' })).resolves.toBe('App text')
  await f.tools[0]!.runRich!({}, { task: 'Find my app session' })
  expect(f.consent.ask).toHaveBeenCalledTimes(1)
  expect(f.consent.enable).toHaveBeenCalledOnce()
  expect(f.consent.ask.mock.calls[0]?.[0]).toMatchObject({ url: 'engram://settings/computer-use' })
  expect(f.rich).toHaveBeenCalledOnce()
})
it.each(['cancel', 'later'] as const)('never reads, opens or enables apps after %s and does not repeat the card', async answer => {
  const f = fixture(); f.consent.ask.mockResolvedValue(answer)
  await expect(f.tools[0]!.run({}, { task: 'Find session' })).rejects.toThrow('not approved')
  await expect(f.tools[0]!.runRich!({}, { task: 'Find session' })).rejects.toThrow('App control is off')
  expect(f.consent.ask).toHaveBeenCalledOnce()
  expect(f.consent.enable).not.toHaveBeenCalled()
  expect(f.run).not.toHaveBeenCalled(); expect(f.rich).not.toHaveBeenCalled()
})
it('does not grant control after Stop while approval is pending', async () => {
  const f = fixture(); const abort = new AbortController()
  f.consent.ask.mockImplementation(async () => { abort.abort(); return 'approve' })
  await expect(f.tools[0]!.run({}, { task: 'Find session', signal: abort.signal })).rejects.toThrow()
  expect(f.consent.enable).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
})
it('does not access apps without an approval route and checks revocation on every call', async () => {
  const run = vi.fn(async () => 'text')
  let enabled = true
  const [tool] = desktopOptIn([{ name: 'list_apps', description: '', argsSchema: {}, run }], { enabled: async () => enabled, enable: vi.fn() })
  await tool!.run({}, { task: 'Find app' })
  enabled = false
  await expect(tool!.run({}, { task: 'Find app' })).rejects.toThrow('Control apps in Settings')
  expect(run).toHaveBeenCalledOnce()
})
