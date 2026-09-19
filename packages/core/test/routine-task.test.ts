import { describe, expect, it } from 'vitest'
import { addBotTask, appendBotTurn, createBot } from '../src/bots.js'
import { routineTask, routineTaskPrompt } from '../src/routine-task.js'
import { addRoutine, listRoutines, removeRoutine, renameRoutine, routineWrites } from '../src/routine.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'
import { readNote, writeNote } from '../src/notes.js'

describe('saved task routines', () => {
  it('keeps known batch addresses without learning response contents or old readiness values', () => {
    const task = routineTask('Read the current reports', [{ tool: 'read_pages', args: { pages: [
      { url: 'https://example.com/reports', ready: 'Old date and private value' },
      { url: 'https://example.com/?token=secret', ready: 'Ready' },
    ] }, observation: 'Batch read: 2/2 readiness checks passed. Old record contents.' }])
    expect(task.urls).toEqual(['https://example.com/reports'])
    expect(task.surface).toBe('web')
    expect(JSON.stringify(task)).not.toMatch(/Old|private|secret/)
  })
  it('reads external note changes immediately after a completed listing', async () => {
    const paths = await initVault(await tmpVaultRoot('routine-external-'), { git: false })
    const saved = await addRoutine(paths, { name: 'Original', steps: [{ kind: 'read' }] })
    expect(await listRoutines(paths)).toHaveLength(1)
    const note = await readNote(paths, saved.id)
    note.front.id = `${saved.id}-external`
    note.body = '# External routine\n'
    await writeNote(paths, note)
    expect((await listRoutines(paths)).map(one => one.id)).toContain(note.front.id)
    note.front.status = 'archived'
    await writeNote(paths, note)
    expect((await listRoutines(paths)).map(one => one.id)).not.toContain(note.front.id)
  })
  it('retains verified execution settings and resolves temporary controls from preceding observations', async () => {
    const task = routineTask('Check leave used this month', [
      { tool: 'read_page', args: {}, observation: '#12 [button] View profile' },
      { tool: 'press', args: { target: '#12' }, observation: 'pressed' },
      { tool: 'press', args: { target: '#12' }, observation: 'pressed' },
      { tool: 'task_plan', args: { phases: ['Check leave dates and cancellations'] }, observation: 'saved' },
    ])
    expect(task.method.join('\n')).toContain('View profile')
    expect(task.checks).toEqual(['Check leave dates and cancellations'])
    expect(task.method.join('\n')).not.toContain('#12')
    task.execution = { engine: 'claude', model: 'opus', effort: 'medium' }
    const paths = await initVault(await tmpVaultRoot('saved-execution-'), { git: false })
    const saved = await addRoutine(paths, { name: 'Monthly leave', steps: [], task })
    expect((await listRoutines(paths))[0]?.task).toEqual(task)
    expect(routineTaskPrompt(saved)).toContain('original')
  })
  it('retains full addresses and a long method without replaying transient targets or typed secrets', async () => {
    const steps = Array.from({ length: 39 }, () => ({ tool: 'press', args: { target: '#18' }, observation: 'pressed' }))
    const task = routineTask('Collect every detail and verify the table', [
      { tool: 'open_page', args: { url: 'https://portal.example/reports?view=weekly' }, observation: 'opened' },
      ...steps,
      { tool: 'type_text', args: { target: 'Search', text: 'private text' }, observation: 'typed' },
    ], ['Earlier request: https://portal.example/home', 'https://example.com/?access_token=secret', 'https://user:password@example.com', 'https://sso.example/?SAMLRequest=secret'])
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
    expect(routineTask('Read their remarks too', [], ['Find last week’s time entries', 'Read their remarks too']).context).toBeUndefined()
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
