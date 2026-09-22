import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changeRoutineLearning, learnRoutineTurn, readRoutineLearning, startRoutineLearning } from '../src/routine-learning.js'
import { vaultPaths } from '../src/vault.js'

async function fixture() {
  const parent = join(process.cwd(), 'tmp')
  await mkdir(parent, { recursive: true })
  return vaultPaths(await mkdtemp(join(parent, 'routine-learning-')))
}

describe('explicit per-conversation routine learning', () => {
  it('persists only post-start work, isolates chats and rejects late turns after discard', async () => {
    const paths = await fixture()
    const first = (await startRoutineLearning(paths, 'one'))!
    await startRoutineLearning(paths, 'two')
    await expect(startRoutineLearning(paths, 'one')).rejects.toThrow('Finish or discard')
    const steps = [{ tool: 'open_page', args: { url: 'https://example.com/reports' }, observation: 'Reports' }]
    await learnRoutineTurn(paths, 'one', undefined, 'Old turn', steps, true)
    expect((await readRoutineLearning(paths, 'one'))?.requests).toEqual([])
    await Promise.all([
      learnRoutineTurn(paths, 'one', first.id, 'Check the reports', steps, true),
      learnRoutineTurn(paths, 'one', first.id, 'Include totals', [], true),
    ])
    expect((await readRoutineLearning(paths, 'one'))?.requests).toEqual(['Check the reports', 'Include totals'])
    expect((await readRoutineLearning(paths, 'two'))?.requests).toEqual([])
    await changeRoutineLearning(paths, 'one', () => null)
    const next = (await startRoutineLearning(paths, 'one'))!
    await learnRoutineTurn(paths, 'one', first.id, 'Late completion', steps, true)
    expect(await readRoutineLearning(paths, 'one')).toEqual(next)
    await expect(readRoutineLearning(paths, '../escape')).rejects.toThrow('Invalid conversation')
  })

  it('keeps failures unverified, excludes raw observations and stops explicitly at the capture limit', async () => {
    const paths = await fixture()
    const capture = (await startRoutineLearning(paths, 'one'))!
    await learnRoutineTurn(paths, 'one', capture.id, 'Check https://example.com/?token=secret', [
      { tool: 'type_text', args: { text: 'private typed value', target: 'Entry' }, observation: 'private response content' },
    ], false)
    for (let i = 1; i < 20; i++) await learnRoutineTurn(paths, 'one', capture.id, `Request ${i}`, [], true)
    const value = (await readRoutineLearning(paths, 'one'))!
    expect(value).toMatchObject({ phase: 'review', limited: true, incomplete: 1, task: { method: [], urls: [] } })
    await learnRoutineTurn(paths, 'one', capture.id, 'Over limit', [], true)
    expect((await readRoutineLearning(paths, 'one'))?.requests).toHaveLength(20)
    const raw = await readFile(join(paths.privateDir, 'routine-learning', 'one.json'), 'utf8')
    expect(raw).not.toContain('private response content')
    expect(raw).not.toContain('private typed value')
  })
})
