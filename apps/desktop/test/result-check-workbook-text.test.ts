import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { artifactHref, priorOutputs, saveArtifact, type TurnStep } from 'core'
import { checkResult } from '../src/main/result-check.js'

vi.mock('electron', () => ({ app: { getPath: () => '' }, dialog: {}, ipcMain: { handle: () => {}, removeHandler: () => {} }, shell: {}, nativeImage: {} }))

let root: string
beforeEach(async () => { await mkdir(resolve('tmp'), { recursive: true }); root = await mkdtemp(resolve('tmp/result-check-workbook-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('links a name with parentheses so its own conversation can find it again', async () => {
  const saved = await saveArtifact(join(root, 'artifacts'), '인계(2026.10.11.).csv', Buffer.from('a,b\n1,2\n'))
  expect(saved.markdownLink).toContain(`engram-artifact:${artifactHref(saved.artifact)})`)
  expect(saved.markdownLink).not.toMatch(/engram-artifact:[^)]*\(/)
  expect(await priorOutputs(join(root, 'artifacts'), [{ role: 'assistant', text: `Done: ${saved.markdownLink}` }])).toEqual([{ name: '인계(2026.10.11.).csv', path: saved.path }])
})

it('accepts a workbook reread through its extracted text, page by page to the end', () => {
  const path = 'C:/artifacts/handoff.xlsx', hash = 'b'.repeat(64)
  const made: TurnStep = { tool: 'file_create_workbook', args: { name: 'handoff.xlsx' }, observation: JSON.stringify({ path, sha256: hash, sheets: [{ sheet: 'A' }, { sheet: 'B' }] }) }
  const page = (offset: number, content: string, total: number): TurnStep => ({ tool: 'file_read', args: { path, offset }, observation: JSON.stringify({
    path, sha256: hash, offset, content, characters: total, truncated: offset + content.length < total, nextOffset: offset + content.length < total ? offset + content.length : null,
  }) })
  const source = 'C:/fixtures/source.xlsx'
  expect(checkResult([made, page(0, '## A\n1', 12), page(6, '## B\n2', 12)], [], [source]).issues.join(' ')).not.toContain('handoff.xlsx')
  expect(checkResult([made, page(0, '## A\n1', 12)], [], [source]).issues.join(' ')).toContain('handoff.xlsx')
})

it('points an answer at the newest revision of each linked file saved during the task', async () => {
  const { newestRevisions } = await import('../src/main/file-work.js')
  const directory = join(root, 'artifacts')
  const draft = await saveArtifact(directory, '인계(1).csv', Buffer.from('a\n1\n'))
  const since = Date.now() - 1000
  await new Promise(done => setTimeout(done, 20))
  const fixed = await saveArtifact(directory, '인계(1).csv', Buffer.from('a\n2\n'))
  const other = await saveArtifact(directory, 'other.csv', Buffer.from('b\n1\n'))
  const answer = `See ${draft.markdownLink} and ${other.markdownLink}`
  expect(await newestRevisions(directory, answer, since)).toBe(`See ${fixed.markdownLink} and ${other.markdownLink}`)
  expect(await newestRevisions(directory, answer, Date.now() + 60_000)).toBe(answer)
})
