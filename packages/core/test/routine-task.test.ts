import { describe, expect, it } from 'vitest'
import { addBotTask, appendBotTurn, createBot } from '../src/bots.js'
import { routineTask, routineTaskPrompt } from '../src/routine-task.js'
import { addRoutine, listRoutines, removeRoutine, renameRoutine, routineWrites } from '../src/routine.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

describe('saved task routines', () => {
  it('retains full addresses and a long method without replaying transient targets or typed secrets', async () => {
    const steps = Array.from({ length: 39 }, () => ({ tool: 'press', args: { target: '#18' }, observation: 'pressed' }))
    const task = routineTask('Collect every detail and verify the table', [
      { tool: 'open_page', args: { url: 'https://portal.example/reports?view=weekly' }, observation: 'opened' },
      ...steps,
      { tool: 'type_text', args: { target: 'Search', text: 'private text' }, observation: 'typed' },
    ], ['Earlier request: https://portal.example/home', 'https://example.com/?access_token=secret', 'https://user:password@example.com'])
    expect(task.surface).toBe('web')
    expect(task.urls).toEqual(['https://portal.example/reports?view=weekly', 'https://portal.example/home'])
    expect(task.method).toHaveLength(41)
    expect(JSON.stringify(task)).not.toContain('private text')
    const paths = await initVault(await tmpVaultRoot('saved-task-'), { git: false })
    const saved = await addRoutine(paths, { name: 'Weekly details', steps: [], task })
    expect((await listRoutines(paths))[0]?.task).toEqual(task)
    expect(routineWrites(saved)).toBe(true)
    await renameRoutine(paths, saved.id, 'Details')
    expect((await listRoutines(paths))[0]).toMatchObject({ name: 'Details', task })
    expect(routineTaskPrompt(saved)).toContain('not desktop mouse/keyboard')
    expect(routineTaskPrompt(saved)).toContain('verify every requested result')
  })

  it('keeps mixed work generic and rejects invalid saved addresses', async () => {
    expect(routineTask('Use my password is abcDEF123', []).goal).not.toContain('abcDEF123')
    expect(routineTask('Prepare a file', [{ tool: 'excel_write', args: {}, observation: '{}' }], ['https://example.com']).surface).toBe('auto')
    const paths = await initVault(await tmpVaultRoot('saved-invalid-'), { git: false })
    await expect(addRoutine(paths, { name: 'Invalid', steps: [], task: { goal: 'Read', urls: ['file:///private'], method: [], surface: 'web' } })).rejects.toThrow()
  })

  it('migrates chat-only tasks into the library once and never restores an archived one', async () => {
    const paths = await initVault(await tmpVaultRoot('saved-migration-'), { git: false })
    const bot = await createBot(paths, { name: 'Original chat' })
    await appendBotTurn(paths, bot.id, { role: 'user', text: 'Read https://portal.example/home?mode=report', at: new Date().toISOString() })
    await addBotTask(paths, bot.id, { name: 'Collect details', goal: 'Read each item and summarize' })
    const [first, parallel] = await Promise.all([listRoutines(paths), listRoutines(paths)])
    expect(parallel).toEqual(first)
    expect(first).toHaveLength(1)
    expect(first[0]?.task?.urls).toEqual(['https://portal.example/home?mode=report'])
    expect((await listRoutines(paths)).map(one => one.id)).toEqual(first.map(one => one.id))
    await removeRoutine(paths, first[0]!.id)
    expect(await listRoutines(paths)).toEqual([])
  })
})
