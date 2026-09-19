import { test, expect, _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DevelopersApi, DevProvider } from '../src/shared/developers.js'

test.skip(process.env['ENGRAM_DEV_LIVE'] !== '1', 'Requires explicit live provider verification.')
for (const provider of ['codex', 'claude'] as DevProvider[]) test(`${provider} reads an isolated fixture through its real development runtime`, async () => {
  test.setTimeout(360_000)
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'dev-live-')), userData = join(root, 'data'), project = join(root, 'project'), vault = join(root, 'vault')
  await Promise.all([mkdir(userData), mkdir(project), initVault(vault, { git: false })])
  await writeFile(join(project, 'example.ts'), 'export const verificationValue = 731942\n')
  if (provider === 'claude') {
    const source = process.env['ENGRAM_DEV_CLAUDE_RUNTIME']
    if (!source) throw new Error('Set ENGRAM_DEV_CLAUDE_RUNTIME to the existing runtimes directory.')
    await symlink(source, join(userData, 'runtimes'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, project)
    const id = await page.evaluate(async provider => {
      const api = (window as unknown as { engram: DevelopersApi }).engram
      await api.devPreferences({ enabled: true })
      const repo = await api.devAddRepo()
      const task = await api.devCreate({ repoId: repo!.id, provider, model: '', mode: 'review', isolate: false })
      await api.devSend(task.id, 'Read example.ts in this folder and report the exact verificationValue. Do not edit files, use the network, or access any other folder.')
      return task.id
    }, provider)
    await expect.poll(async () => page.evaluate(async id => {
      const api = (window as unknown as { engram: DevelopersApi }).engram, task = await api.devSession(id)
      for (const approval of task.pending) {
        const command = approval.detail.split('\n')[0] ?? ''
        if (approval.kind !== 'permission' || !/^"[^"\r\n]+(?:pwsh|powershell)\.exe" -Command "Get-Content -LiteralPath \.\\+example\.ts(?: -Raw)?"$/.test(command)) {
          await api.devStop(id); throw new Error(`Unexpected fixture approval: ${approval.title}: ${command}`)
        }
        await api.devRespond(id, approval.id, { decision: 'allow' })
      }
      if (task.state === 'failed') throw new Error(task.items.filter(item => item.kind === 'error').map(item => item.text).join('\n'))
      return task.state === 'idle' && task.items.some(item => item.kind === 'assistant' && item.text.includes('731942'))
    }, id), { timeout: 180_000, intervals: [1000] }).toBe(true)
    await page.evaluate(async id => { await (window as unknown as { engram: DevelopersApi }).engram.devStop(id) }, id)
    await page.evaluate(async id => { await (window as unknown as { engram: DevelopersApi }).engram.devSend(id, 'Without using any tools, repeat the exact verificationValue you just read.') }, id)
    await expect.poll(async () => page.evaluate(async id => {
      const task = await (window as unknown as { engram: DevelopersApi }).engram.devSession(id)
      if (task.state === 'failed') throw new Error(task.items.filter(item => item.kind === 'error').map(item => item.text).join('\n'))
      const lastUser = task.items.reduce((last, item, index) => item.kind === 'user' ? index : last, -1)
      return task.state === 'idle' && task.items.slice(lastUser + 1).some(item => item.kind === 'assistant' && item.text.includes('731942'))
    }, id), { timeout: 120_000, intervals: [1000] }).toBe(true)
    await page.evaluate(async id => { await (window as unknown as { engram: DevelopersApi }).engram.devSend(id, 'Change verificationValue in example.ts from 731942 to 731943 using your file-edit tool, not a shell command. Modify only this file. Report the new value after editing.') }, id)
    await expect.poll(async () => page.evaluate(async ({ id, project }) => {
      const api = (window as unknown as { engram: DevelopersApi }).engram, task = await api.devSession(id)
      for (const approval of task.pending) {
        const path = (approval.changes?.[0]?.path ?? approval.detail.split('\n')[0] ?? '').replaceAll('\\', '/')
        const ownFile = path === 'example.ts' || path === `${project.replaceAll('\\', '/')}/example.ts`
        const preview = approval.changes?.length === 1 && approval.changes[0]?.before === 'export const verificationValue = 731942\n' && approval.changes[0]?.after === 'export const verificationValue = 731943\n'
        const patch = approval.title === 'Allow file changes?' && approval.detail.length < 1000 && approval.detail.includes('-export const verificationValue = 731942') && approval.detail.includes('+export const verificationValue = 731943')
        const read = /^"[^"\r\n]+(?:pwsh|powershell)\.exe" -Command "Get-Content -LiteralPath \.\\+example\.ts(?: -Raw)?"$/.test(approval.detail.split('\n')[0] ?? '')
        if (approval.kind !== 'permission' || (!read && (!ownFile || (!preview && !patch)))) { await api.devStop(id); throw new Error(`Unexpected edit fixture approval: ${approval.title}: ${approval.detail}`) }
        await api.devRespond(id, approval.id, { decision: 'allow' })
      }
      if (task.state === 'failed') throw new Error(task.items.filter(item => item.kind === 'error').map(item => item.text).join('\n'))
      const lastUser = task.items.reduce((last, item, index) => item.kind === 'user' ? index : last, -1)
      return task.state === 'idle' && task.items.slice(lastUser + 1).some(item => item.kind === 'assistant' && item.text.includes('731943'))
    }, { id, project }), { timeout: 150_000, intervals: [1000] }).toBe(true)
    expect(await readFile(join(project, 'example.ts'), 'utf8')).toBe('export const verificationValue = 731943\n')
    await page.evaluate(async id => { await (window as unknown as { engram: DevelopersApi }).engram.devStop(id) }, id)
  } finally { await app.close() }
})
