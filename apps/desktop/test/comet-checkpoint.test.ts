import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resumeCheckpoint, type VaultPaths } from 'core'
import { changeCheckpoint, readCheckpoint } from '../src/main/comet-checkpoint.js'

it('persists concurrent requests and checkpoints without losing either, and clears only acknowledged requests', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'engram-checkpoint-'))
  const paths = { cache } as VaultPaths
  try {
    await Promise.all([
      changeCheckpoint(paths, 'one', state => ({ ...state, pending: [...state.pending, 'Also Busan'] })),
      changeCheckpoint(paths, 'one', state => ({ ...state, context: 'Confirmed total: 393 at https://example.test/report' })),
      changeCheckpoint(paths, 'one', state => ({ ...state, pending: [...state.pending, 'Compare both'] })),
    ])
    expect(await readCheckpoint(paths, 'one')).toEqual({ context: 'Confirmed total: 393 at https://example.test/report', pending: ['Also Busan', 'Compare both'] })
    await changeCheckpoint(paths, 'one', state => ({ ...state, pending: state.pending.filter(text => text !== 'Also Busan') }))
    expect(JSON.parse(await readFile(join(cache, 'checkpoints/one.json'), 'utf8')).pending).toEqual(['Compare both'])
    expect(() => changeCheckpoint(paths, '../outside', state => state)).toThrow('Invalid conversation ID')
  } finally { await rm(cache, { recursive: true, force: true }) }
})

it('keeps the checkpoint valid JSON when a labelled secret ends in a character JSON escapes', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'engram-checkpoint-'))
  const paths = { cache } as VaultPaths
  try {
    const request = 'deploy with token ab12\\ then report "done"'
    const context = resumeCheckpoint(request, { answer: 'Used the token ab12\\ once', steps: [], fellBack: false, incomplete: 'Check the token ab12\\ result' })
    await changeCheckpoint(paths, 'team', state => ({ ...state, context, pending: [...state.pending, request] }))
    const raw = await readFile(join(cache, 'checkpoints/team.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(raw).not.toContain('ab12')
    const stored = await readCheckpoint(paths, 'team')
    expect(stored.pending).toEqual(['deploy with token •••••• then report "done"'])
    expect(JSON.parse(stored.context!)).toMatchObject({ request: 'deploy with token •••••• then report "done"', remaining: 'Check the token •••••• result', lastResponse: 'Used the token •••••• once' })
  } finally { await rm(cache, { recursive: true, force: true }) }
})

it('recovers from an already corrupted checkpoint instead of failing every turn', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'engram-checkpoint-'))
  const paths = { cache } as VaultPaths
  try {
    await mkdir(join(cache, 'checkpoints'), { recursive: true })
    await writeFile(join(cache, 'checkpoints/bricked.json'), '{"context":"stopped at the token ••••••\\ ","pending":[]}')
    expect(await readCheckpoint(paths, 'bricked')).toEqual({ pending: [] })
    await changeCheckpoint(paths, 'bricked', state => ({ ...state, pending: [...state.pending, '이어서 해줘'] }))
    expect(JSON.parse(await readFile(join(cache, 'checkpoints/bricked.json'), 'utf8'))).toEqual({ pending: ['이어서 해줘'] })
    expect(await readCheckpoint(paths, 'bricked')).toEqual({ pending: ['이어서 해줘'] })
  } finally { await rm(cache, { recursive: true, force: true }) }
})

it('keeps its own field names when a labelled secret equals one of them', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'engram-checkpoint-'))
  const paths = { cache } as VaultPaths
  try {
    await changeCheckpoint(paths, 'names', state => ({ ...state, context: 'resume here', pending: [...state.pending, 'my token: pending'] }))
    expect(await readCheckpoint(paths, 'names')).toEqual({ context: 'resume here', pending: ['my token: ••••••'] })
  } finally { await rm(cache, { recursive: true, force: true }) }
})

it('keeps a nested resume record valid JSON when a later message labels a secret it carries unlabelled', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'engram-checkpoint-'))
  const paths = { cache } as VaultPaths
  try {
    const context = JSON.stringify({ request: 'use ab12\\', remaining: 'check', committedActions: [] })
    await changeCheckpoint(paths, 'nested', state => ({ ...state, context, pending: ['the token ab12\\'] }))
    const stored = await readCheckpoint(paths, 'nested')
    expect(stored.context).not.toContain('ab12')
    expect(JSON.parse(stored.context!)).toEqual({ request: 'use ••••••', remaining: 'check', committedActions: [] })
  } finally { await rm(cache, { recursive: true, force: true }) }
})

it('cleans a value labelled inside the stored resume record even though it is escaped there', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'engram-checkpoint-'))
  const paths = { cache } as VaultPaths
  try {
    const context = JSON.stringify({ request: 'deploy', remaining: 'the token ab12\\ still needs a retry' })
    await changeCheckpoint(paths, 'escaped', state => ({ ...state, context, pending: [] }))
    const stored = await readCheckpoint(paths, 'escaped')
    expect(stored.context).not.toContain('ab12')
    expect(JSON.parse(stored.context!).remaining).toBe('the token •••••• still needs a retry')
  } finally { await rm(cache, { recursive: true, force: true }) }
})

it('cleans a pending message of a value labelled only inside the escaped resume record', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'engram-checkpoint-'))
  const paths = { cache } as VaultPaths
  try {
    const context = JSON.stringify({ remaining: 'the token ab12\\ retry' })
    await changeCheckpoint(paths, 'pending-escaped', state => ({ ...state, context, pending: ['send ab12\\'] }))
    const stored = await readCheckpoint(paths, 'pending-escaped')
    expect(stored.pending).toEqual(['send ••••••'])
    expect(JSON.stringify(stored)).not.toContain('ab12')
  } finally { await rm(cache, { recursive: true, force: true }) }
})
