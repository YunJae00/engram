import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { findPlaybook, playbookContext, recordPlaybook } from '../src/task-playbooks.js'
import type { VaultPaths } from '../src/vault.js'

const step = (tool: string, args: Record<string, unknown>, observation = 'ok') => ({ tool, args, observation })
const trail = [
  step('open_page', { url: 'https://expenses.example/new?token=secret-1' }),
  step('open_page', { url: 'https://expenses.example/new' }),
  step('type_text', { target: 'Amount' }),
  step('press', { target: 'Submit' }),
  step('press', { target: 'Confirm' }, '"Confirm" was not pressed: it waits'),
]

it('keeps the steps that worked and hands them to a similar request only', async () => {
  const paths = { cache: join(await mkdtemp(join(tmpdir(), 'engram-playbooks-')), '.engram') } as VaultPaths
  expect(await recordPlaybook(paths, 'Look up the exchange rate', [step('search_web', { query: 'EUR KRW' })])).toBe(false)
  expect(await recordPlaybook(paths, 'File the taxi receipt as an expense', trail)).toBe(true)
  expect(await recordPlaybook(paths, 'File the taxi receipt as an expense', trail)).toBe(true)
  expect(await findPlaybook(paths, 'Book a meeting room for Tuesday')).toBeUndefined()
  const found = (await findPlaybook(paths, 'File the hotel receipt as an expense'))!
  expect(found.urls).toEqual(['https://expenses.example/new'])
  expect(found.method).toEqual(['open_page', 'open_page', 'type_text: Amount', 'press: Submit'])
  expect(playbookContext(found)).toContain('hints only')
  expect(JSON.parse(await readFile(join(paths.cache, 'task-playbooks.json'), 'utf8'))).toHaveLength(1)
})

it('preserves a malformed method store instead of silently replacing it', async () => {
  const cache = join(await mkdtemp(join(tmpdir(), 'engram-playbooks-')), '.engram')
  const paths = { cache } as VaultPaths
  await mkdir(cache)
  const invalid = JSON.stringify([{ goal: 'File the receipt', urls: [42], method: ['press'] }])
  await writeFile(join(cache, 'task-playbooks.json'), invalid)
  await expect(findPlaybook(paths, 'File the receipt')).rejects.toThrow('preserved')
  await expect(recordPlaybook(paths, 'File the receipt', trail)).rejects.toThrow('preserved')
  expect(await readFile(join(cache, 'task-playbooks.json'), 'utf8')).toBe(invalid)
})
