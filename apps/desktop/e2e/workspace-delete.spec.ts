import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// There is one workspace. A person who had two opens the app and finds both in it: nothing to switch,
// nothing deleted, and the second folder exactly as it was.
test('two workspaces open as one: the other one\'s bots, conversations and notes are here and its folder is untouched', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const fixture = await mkdtemp(join(tmp, 'e2e-one-workspace-'))
  const root = join(fixture, 'vault'), other = join(fixture, 'work'), userData = join(fixture, 'profile')
  const bot = (id: string, name: string, more: Record<string, unknown> = {}) => ({ id, name, purpose: '', createdAt: '2026-11-01T00:00:00.000Z', ...more })
  const seed = async (vault: string, bots: unknown[], chats: Record<string, string>, note: string) => {
    const paths = await initVault(vault, { git: false })
    await mkdir(join(paths.cache, 'bot-chats'), { recursive: true })
    await writeFile(join(paths.cache, 'bots.json'), JSON.stringify({ version: 2, bots, dismissed: [] }))
    for (const [id, text] of Object.entries(chats)) await writeFile(join(paths.cache, 'bot-chats', `${id}.jsonl`), `${JSON.stringify({ role: 'assistant', text, at: '2026-11-01T00:00:00.000Z' })}\n`)
    await writeFile(join(paths.notes, `${note}.md`), `---\nid: ${note}\ntype: note\nstatus: current\ncreated: 2026-11-01T00:00:00.000Z\n---\n# ${note}\n`)
    return paths
  }
  await seed(root, [bot('bot-a-1', 'Chief', { primary: true }), bot('bot-a-2', 'Kim', { label: 'Research' })], { 'bot-a-1': 'Hello from the open workspace.' }, 'n-here-1')
  const work = await seed(other, [bot('bot-a-1', 'Chief', { primary: true }), bot('bot-b-9', 'Park', { label: 'Design' })], { 'bot-a-1': 'Hello from the other chief.', 'bot-b-9': 'Park reporting from the other workspace.' }, 'n-there-1')
  const before = JSON.stringify([await readdir(work.notes), await readFile(join(work.cache, 'bots.json'), 'utf8'), await readdir(join(work.cache, 'bot-chats'))])
  await mkdir(userData)
  const registry = { current: 'test', vaults: [
    { id: 'test', name: 'Test workspace', root, kind: 'personal', createdAt: new Date().toISOString() },
    { id: 'work', name: 'Work', root: other, kind: 'personal', createdAt: new Date().toISOString() },
  ] }
  await writeFile(join(userData, 'vaults.json'), JSON.stringify(registry))
  const launch = () => electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: '', ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'mock', ENGRAM_HIDDEN: '1' } })
  let app: ElectronApplication | undefined = await launch()
  try {
    let page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    // The menu only leads to places; nothing in it makes, switches to or deletes a workspace.
    await page.getByTestId('engram-menu-button').click()
    const menu = page.getByTestId('engram-menu')
    await expect(menu.getByRole('button')).toHaveCount(3)
    await expect(menu).not.toContainText(/workspace/i)
    await expect(page.locator('.workspace-management')).toHaveCount(0)
    await page.keyboard.press('Escape')
    // Everyone from both is in the sidebar; the second chief of staff says where it came from.
    const sidebar = page.getByTestId('app-sidebar')
    for (const name of ['Chief', 'Kim', 'Chief (Work)', 'Park']) await expect(sidebar.getByText(name, { exact: true }).first()).toBeVisible()
    const bots = await page.evaluate(() => window.engram.botsList())
    expect(bots.map(one => one.name).sort()).toEqual(['Chief', 'Chief (Work)', 'Kim', 'Park'])
    expect(bots.filter(one => one.primary).map(one => one.id)).toEqual(['bot-a-1'])
    // Its conversation came with it.
    await sidebar.getByText('Park', { exact: true }).first().click()
    await expect(page.getByTestId('bots-view')).toContainText('Park reporting from the other workspace.')
    const merged = await initVault(root, { git: false })
    expect((await readdir(merged.notes)).sort()).toEqual(['n-here-1.md', 'n-there-1.md'])
    // The other folder and the registry are as they were.
    expect(JSON.stringify([await readdir(work.notes), await readFile(join(work.cache, 'bots.json'), 'utf8'), await readdir(join(work.cache, 'bot-chats'))])).toBe(before)
    expect(JSON.parse(await readFile(join(userData, 'vaults.json'), 'utf8'))).toEqual(registry)
    await app.close()
    app = undefined

    // A second launch adds no one twice.
    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    expect((await page.evaluate(() => window.engram.botsList())).map(one => one.name).sort()).toEqual(['Chief', 'Chief (Work)', 'Kim', 'Park'])
  } finally { await app?.close() }
})
