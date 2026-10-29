import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { VaultPaths } from 'core'
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
