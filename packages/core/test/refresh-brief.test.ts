import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MockEngine } from '../src/engine/mock.js'
import { refreshBrief } from '../src/jobs/sweep.js'
import { createNote } from '../src/notes.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-27T09:00:00Z')
const BRIEF = '# 브리핑\n\n## Today’s briefing\n\n- **세금 신고** — 기한 지남'

describe('refreshBrief', () => {
  async function vaultWithLoop(prefix: string) {
    const paths = await initVault(await tmpVaultRoot(prefix), { git: false })
    await createNote(paths, { id: 'n-tax', body: '# 세금 신고\n\n해야 함', open_loop: true }, NOW)
    return paths
  }

  it('writes a brief without running a sweep', async () => {
    const paths = await vaultWithLoop('brief-refresh')
    const result = await refreshBrief(paths, [new MockEngine({ J8: BRIEF })], { now: () => NOW })
    expect(result.written).toBe(true)
    const briefs = (await readdir(paths.views)).filter((f) => f.startsWith('brief-'))
    expect(briefs).toHaveLength(1)
  })

  it('costs nothing the second time when nothing changed', async () => {
    const paths = await vaultWithLoop('brief-refresh-skip')
    const engine = new MockEngine({ J8: BRIEF })
    await refreshBrief(paths, [engine], { now: () => NOW })
    const second = await refreshBrief(paths, [engine], { now: () => NOW })
    expect(second.written).toBe(false)
  })

  it('does nothing and reports so when no engine is connected', async () => {
    const paths = await vaultWithLoop('brief-refresh-noengine')
    expect(await refreshBrief(paths, [], { now: () => NOW })).toEqual({ written: false })
    expect((await readdir(paths.views)).filter((f) => f.startsWith('brief-'))).toHaveLength(0)
  })
})
