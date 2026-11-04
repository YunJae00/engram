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
  it('opens an app by its name, and answers several matches or none with a list instead of guessing', async () => {
    const { apps, launch, open } = fixture()
    apps.mockResolvedValue(JSON.stringify([{ id: 'a'.repeat(64), name: 'Calculator' }, { id: 'b'.repeat(64), name: 'Outlook (classic)' }, { id: 'c'.repeat(64), name: 'Outlook (new)' }]))
    expect(await launch.run({ app: 'calculator' }, { task: 'Open calculator' })).toContain('observe')
    expect(open).toHaveBeenLastCalledWith('a'.repeat(64), undefined)
    const several = JSON.parse(await launch.run({ app: 'Outlook' }, { task: 'Open Outlook' }))
    expect(several.matches.map((app: { name: string }) => app.name)).toEqual(['Outlook (classic)', 'Outlook (new)'])
    const none = JSON.parse(await launch.run({ app: 'Paint' }, { task: 'Open Paint' }))
    expect(none).toMatchObject({ opened: false, catalogCount: 3, suggestions: expect.arrayContaining(['Calculator', 'Outlook (classic)', 'Outlook (new)']) })
    expect(none.reason).toContain('does not prove the app is uninstalled')
    expect(open).toHaveBeenCalledTimes(1)
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


it('attaches an open app before reading the launch catalog', async () => {
  const attach = vi.fn().mockResolvedValue('{"alreadyOpen":true}')
  const apps = vi.fn(), open = vi.fn()
  const launch = desktopTools({ attach, apps, open, read: async () => '' }).find(tool => tool.name === 'open_app')!
  expect(await launch.run({ app: 'Teams' }, { task: 'Read Teams' })).toBe('{"alreadyOpen":true}')
  expect(attach).toHaveBeenCalledWith('Teams', undefined)
  expect(apps).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
})
it('resolves opaque app IDs to names for attachment before launching', async () => {
  const id = 'b'.repeat(64), attach = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('{"alreadyOpen":true}')
  const apps = vi.fn().mockResolvedValue(JSON.stringify([{ id, name: 'Teams' }]))
  const open = vi.fn()
  const launch = desktopTools({ attach, apps, open, read: async () => '' }).find(tool => tool.name === 'open_app')!
  expect(await launch.run({ app: id }, { task: 'Read Teams' })).toContain('alreadyOpen')
  expect(attach).toHaveBeenLastCalledWith('Teams', undefined)
  expect(open).not.toHaveBeenCalled()
})
