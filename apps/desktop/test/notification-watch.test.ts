import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('../src/main/app-icons.js', () => ({ appPaths: async () => ({ 'ms-teams': 'C:\\Program Files\\WindowsApps\\MSTeams_1.0_x64__8wekyb3d8bbwe\\ms-teams.exe' }) }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { notificationsTool, onToastLine, peekToasts, setToastAppsOff, startToastLog } from '../src/main/notification-watch.js'
import type { VaultContext } from '../src/main/vault.js'

const line = (key: string, app: string, aumid: string, texts: string[]) => JSON.stringify({ key, app, aumid, at: new Date().toISOString(), texts })

it('keeps each notification once, hides codes, and leaves out apps turned off', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'toasts-'))
  const ctx = { paths: { workspace } } as unknown as VaultContext
  startToastLog(ctx)
  setToastAppsOff(['slack'])
  const teams = line('MSTeams_8wekyb3d8bbwe!MSTeams|1|1', 'Microsoft Teams', 'MSTeams_8wekyb3d8bbwe!MSTeams', ['Mina', 'Lunch at noon?'])
  onToastLine(teams)
  // The system list is read whole each time, so the same notification comes again.
  onToastLine(teams)
  onToastLine(line('Bank|2|2', 'Bank', 'Bank', ['Your verification code is 482913']))
  onToastLine(line('com.squirrel.slack.slack|3|3', 'Slack', 'com.squirrel.slack.slack', ['hi']))
  onToastLine('not json')
  for (const invalid of ['null', '[]', 'true', '42']) expect(() => onToastLine(invalid)).not.toThrow()
  const file = join(workspace, '.engram', 'notifications', `${new Date().toISOString().slice(0, 10)}.jsonl`)
  await vi.waitFor(async () => expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2))
  const kept = (await readFile(file, 'utf8')).trim().split('\n').map(one => JSON.parse(one) as { app: string; title: string; text: string })
  expect(kept.map(one => [one.app, one.title, one.text])).toEqual([['Microsoft Teams', 'Mina', 'Lunch at noon?'], ['Bank', '(private)', '']])

  const read = await notificationsTool(ctx).run({ app: 'Teams' }, {} as never)
  expect(read).toMatch(/^- \[[0-9a-f]{12}\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} Microsoft Teams: Mina - Lunch at noon\?$/)
  expect(await peekToasts({ app: 'ms-teams' })).toHaveLength(1)
  expect(await peekToasts({ app: 'Outlook' })).toEqual([])
  // A notification-only app may have been disabled under its display name.
  setToastAppsOff(['Microsoft Teams'])
  expect(await peekToasts({ app: 'ms-teams' })).toEqual([])
  expect(await notificationsTool(ctx).run({ app: 'Teams' }, {} as never)).toContain('No notifications')
})

it('bounds watched notifications to the scheduler history so unchanged items stay seen', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'toasts-watch-'))
  const ctx = { paths: { workspace } } as unknown as VaultContext
  const dir = join(workspace, '.engram', 'notifications')
  await mkdir(dir, { recursive: true })
  const at = new Date().toISOString()
  await writeFile(join(dir, `${at.slice(0, 10)}.jsonl`), Array.from({ length: 205 }, (_, id) => JSON.stringify({ id: String(id), app: 'Teams', aumid: 'Teams', at, title: 'Update', text: '' })).join('\n'))
  startToastLog(ctx)
  setToastAppsOff([])
  const first = await peekToasts({ app: 'Teams' })
  expect(first).toHaveLength(200)
  expect(await peekToasts({ app: 'Teams' })).toEqual(first)
})
