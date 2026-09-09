import { describe, expect, it, vi } from 'vitest'
import { desktopTools, isDesktopTool } from '../src/desktop-tools.js'

describe('desktop app launch tools', () => {
  const appId = 'a'.repeat(64)
  const fixture = () => {
    const apps = vi.fn(async () => '[{"id":"calculator","name":"Calculator"}]')
    const open = vi.fn(async () => 'Launch requested; observe the window.')
    const tools = desktopTools({ apps, open, read: async () => 'observed' })
    return { apps, open, list: tools.find((tool) => tool.name === 'list_apps')!, launch: tools.find((tool) => tool.name === 'open_app')! }
  }
  it('lists then dispatches an exact app ID without inventing success', async () => {
    const { list, launch, open } = fixture()
    expect(await list.run({}, { task: 'Open calculator' })).toContain('calculator')
    expect(await launch.run({ app: appId }, { task: 'Open calculator' })).toContain('observe')
    expect(open).toHaveBeenCalledWith(appId, undefined)
    expect(isDesktopTool('list_apps') && isDesktopTool('open_app')).toBe(true)
  })
  it.each([{ app: '../calc.exe' }, { app: 'calculator', args: '/x' }, { app: 'calc & cmd' }, {}])('rejects non-ID arguments %j', async (args) => {
    const { launch, open } = fixture()
    expect(await launch.run(args, { task: 'Open calculator' })).toContain('not accepted')
    expect(open).not.toHaveBeenCalled()
  })
  it('does not dispatch after cancellation and preserves the first native error', async () => {
    const { launch, open } = fixture()
    await expect(launch.run({ app: appId }, { task: '', signal: AbortSignal.abort() })).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
    open.mockRejectedValueOnce(new Error('Windows refused the launch'))
    await expect(launch.run({ app: appId }, { task: '' })).rejects.toThrow('Windows refused the launch')
    expect(open).toHaveBeenCalledOnce()
  })
})
