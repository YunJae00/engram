import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MockEngine } from '../src/engine/mock.js'
import { buildJ10, digestInput } from '../src/jobs/digest.js'
import { sweep, loadState } from '../src/jobs/sweep.js'
import { createNote, loadNotes } from '../src/notes.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-12T00:00:00Z')

const CANNED = {
  J2: '{"links":[]}',
  J3: '{"cards":[]}',
  J4: '{"cards":[]}',
  J5: '{"cards":[]}',
  J6: '{"estimates":[]}',
  J7: '{"cards":[]}',
  J8: '# 브리핑\n\n요약.',
  J10: '# 주간 다이제스트\n\n## 이번 주 쌓인 것\n\n- 이사 준비가 진행됐다.',
}

describe('J10 weekly digest', () => {
  it('digestInput separates recent / cooling / orphans and skips hubs', async () => {
    const paths = await initVault(await tmpVaultRoot('digest-input'), { git: false })
    const old = new Date('2026-06-01T00:00:00Z')
    await createNote(paths, { id: 'n-recent', body: '# 이번 주\n\n내용' }, NOW)
    await createNote(paths, { id: 'n-linked', body: '# 링크됨\n\n내용', derived_from: ['n-recent'] }, NOW)
    await createNote(paths, { id: 'n-old', body: '# 옛것\n\n내용', decay: 'fast' }, old) // 30d window → stale by NOW
    await createNote(paths, { id: 'n-hub-01', type: 'hub', body: '# 허브\n\n종합', derived_from: ['n-recent'] }, NOW)
    const input = digestInput(await loadNotes(paths), NOW)

    expect(input.recent.map((n) => n.id)).toEqual(expect.arrayContaining(['n-recent', 'n-linked']))
    expect(input.recent.map((n) => n.id)).not.toContain('n-hub-01')
    expect(input.cooling.map((n) => n.id)).toContain('n-old')
    // n-recent/n-linked are linked to each other; n-old never got connected
    expect(input.orphans.map((n) => n.id)).toEqual(['n-old'])
    expect(input.hubs).toEqual(['허브'])
  })

  it('apply writes _views/digest-YYYY-MM-DD.md; a refusal writes nothing', async () => {
    const paths = await initVault(await tmpVaultRoot('digest-apply'), { git: false })
    await createNote(paths, { id: 'n-a', body: '# A\n\n내용' }, NOW)
    const input = digestInput(await loadNotes(paths), NOW)

    const bad = buildJ10(paths, '', input, NOW)
    await expect(bad.apply('죄송합니다. 파일 쓰기 도구가 비활성화되어 저장할 수 없습니다.')).rejects.toThrow()

    const good = buildJ10(paths, '', input, NOW)
    await good.apply('# 주간 다이제스트\n\n## 이번 주 쌓인 것\n\n- A가 생겼다.')
    const body = await readFile(join(paths.views, 'digest-2026-07-12.md'), 'utf8')
    expect(body).toContain('쌓인 것')
  })

  it('sweep writes the digest weekly, not on the next sweep', async () => {
    const paths = await initVault(await tmpVaultRoot('digest-weekly'), { git: false })
    await createNote(paths, { id: 'n-week', body: '# 이번 주 일\n\n내용' }, NOW)
    const engine = new MockEngine(CANNED)

    await sweep(paths, [engine], { now: () => NOW })
    const views1 = (await readdir(paths.views)).filter((f) => f.startsWith('digest-'))
    expect(views1).toEqual(['digest-2026-07-12.md'])
    expect(typeof (await loadState(paths)).last_digest).toBe('string')

    // A day later: due again only after a week — no second digest file.
    await createNote(paths, { id: 'n-next', body: '# 다음 날\n\n내용' }, new Date('2026-07-13T00:00:00Z'))
    await sweep(paths, [engine], { now: () => new Date('2026-07-13T00:00:00Z') })
    const views2 = (await readdir(paths.views)).filter((f) => f.startsWith('digest-'))
    expect(views2).toEqual(['digest-2026-07-12.md'])
  }, 60_000)
})
