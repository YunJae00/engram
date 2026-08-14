import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MockEngine } from '../src/engine/mock.js'
import { buildJ9, linkComponents, matchHub } from '../src/jobs/hub.js'
import { sweep } from '../src/jobs/sweep.js'
import { createNote, loadNotes, readNote } from '../src/notes.js'
import type { Note } from '../src/schema.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-10T00:00:00Z')

function fakeNote(id: string, derived: string[] = [], type = 'note', status: Note['front']['status'] = 'current'): Note {
  return {
    front: {
      id, type, status, supersedes: [], derived_from: derived,
      decay: 'slow', timeline: 'inferred',
      created: NOW.toISOString(), updated: NOW.toISOString(),
    },
    body: `# ${id}\n\n내용`,
  }
}

describe('linkComponents', () => {
  it('finds connected components of size >= 4, largest first', () => {
    const notes = [
      // component of 4 (chain a-b-c-d)
      fakeNote('n-a'), fakeNote('n-b', ['n-a']), fakeNote('n-c', ['n-b']), fakeNote('n-d', ['n-c']),
      // component of 2 — too small
      fakeNote('n-x'), fakeNote('n-y', ['n-x']),
      // isolated
      fakeNote('n-z'),
    ]
    const components = linkComponents(notes)
    expect(components).toHaveLength(1)
    expect(components[0]!.members.map((n) => n.front.id).sort()).toEqual(['n-a', 'n-b', 'n-c', 'n-d'])
    expect(components[0]!.subject).toBeNull()
  })

  it('excludes hub notes from the graph so hubs never weld components together', () => {
    const notes = [
      fakeNote('n-a'), fakeNote('n-b', ['n-a']),
      fakeNote('n-c'), fakeNote('n-d', ['n-c']),
      // a hub linking both pairs must NOT merge them into one component of 4
      fakeNote('n-hub', ['n-a', 'n-b', 'n-c', 'n-d'], 'hub'),
    ]
    expect(linkComponents(notes)).toHaveLength(0)
  })

  it('ignores non-current notes', () => {
    const notes = [
      fakeNote('n-a'), fakeNote('n-b', ['n-a']), fakeNote('n-c', ['n-b']),
      fakeNote('n-d', ['n-c'], 'note', 'superseded'),
    ]
    expect(linkComponents(notes)).toHaveLength(0)
  })
})

describe('matchHub', () => {
  it('picks the hub sharing the most members (>= 2), else null', () => {
    const members = [fakeNote('n-a'), fakeNote('n-b'), fakeNote('n-c'), fakeNote('n-d')]
    const near = fakeNote('n-hub1', ['n-a', 'n-b', 'n-old'], 'hub')
    const far = fakeNote('n-hub2', ['n-a'], 'hub')
    expect(matchHub([near, far], members)?.front.id).toBe('n-hub1')
    expect(matchHub([far], members)).toBeNull()
  })

  // When a topic splits, both halves still overlap the old hub. Handing it to
  // both would have their J9 jobs overwrite each other's synthesis.
  it('never hands the same hub to two topics', () => {
    const old = fakeNote('n-hub1', ['n-a', 'n-b', 'n-c', 'n-d'], 'hub')
    const first = [fakeNote('n-a'), fakeNote('n-b')]
    const second = [fakeNote('n-c'), fakeNote('n-d')]
    const taken = new Set<string>()

    const forFirst = matchHub([old], first, taken)
    expect(forFirst?.front.id).toBe('n-hub1')
    taken.add(forFirst!.front.id)
    // the second half must get a fresh hub, not this one
    expect(matchHub([old], second, taken)).toBeNull()
  })
})

describe('J9 topic hub synthesis', () => {
  const HUB_BODY = '# 배포 개편\n\n- 배포 요일이 화→금으로 옮겨졌고 CI가 선행 조건이 됐다.\n- 열린 질문: 롤백 절차.\n\n## 노트\n\n- 배포 절차 (n-a)'

  async function linkedVault(prefix: string) {
    const paths = await initVault(await tmpVaultRoot(prefix), { git: false })
    await createNote(paths, { id: 'n-a', body: '# 배포 절차\n\n내용' }, NOW)
    await createNote(paths, { id: 'n-b', body: '# 배포 요일\n\n내용', derived_from: ['n-a'] }, NOW)
    await createNote(paths, { id: 'n-c', body: '# CI\n\n내용', derived_from: ['n-b'] }, NOW)
    await createNote(paths, { id: 'n-d', body: '# 롤백\n\n내용', derived_from: ['n-c'] }, NOW)
    return paths
  }

  it('apply creates a hub note deriving from every member', async () => {
    const paths = await linkedVault('j9-create')
    const members = await loadNotes(paths)
    const spec = buildJ9(paths, '', members, null, NOW)
    const effects = await spec.apply(JSON.stringify({ body: HUB_BODY }))
    expect(effects.join('\n')).toContain('hub created')
    const hub = (await loadNotes(paths)).find((n) => n.front.type === 'hub')
    expect(hub).toBeDefined()
    expect(hub!.front.derived_from.sort()).toEqual(['n-a', 'n-b', 'n-c', 'n-d'])
    expect(hub!.body).toContain('# 배포 개편')
  })

  it('apply updates the matched existing hub instead of stacking a new one', async () => {
    const paths = await linkedVault('j9-update')
    const existing = await createNote(
      paths,
      { id: 'n-hub-0001', type: 'hub', body: '# 옛 허브\n\n낡은 종합', derived_from: ['n-a', 'n-b'] },
      NOW,
    )
    const members = (await loadNotes(paths)).filter((n) => n.front.type !== 'hub')
    const spec = buildJ9(paths, '', members, existing, NOW)
    const effects = await spec.apply(JSON.stringify({ body: HUB_BODY }))
    expect(effects.join('\n')).toContain('hub updated')
    const hub = await readNote(paths, 'n-hub-0001')
    expect(hub.body).toContain('# 배포 개편')
    expect(hub.front.derived_from.sort()).toEqual(['n-a', 'n-b', 'n-c', 'n-d'])
    expect((await loadNotes(paths)).filter((n) => n.front.type === 'hub')).toHaveLength(1)
  })

  it('withholds the old synthesis once the topic boundary has moved', async () => {
    const paths = await linkedVault('j9-rename')
    const members = (await loadNotes(paths)).filter((n) => n.front.type !== 'hub')
    const stale = fakeNote('n-hub-0001', ['n-a', 'n-b'], 'hub')
    stale.body = '# 옛 이름\n\n낡은 종합'
    expect(buildJ9(paths, '', members, stale, NOW, 'MyClientology').prompt).not.toContain('옛 이름')
    expect(buildJ9(paths, '', members, stale, NOW, 'MyClientology').prompt).toContain('MyClientology')
    // Same membership = the same topic, so the synthesis carries over.
    const same = fakeNote('n-hub-0002', ['n-d', 'n-c', 'n-b', 'n-a'], 'hub')
    same.body = '# 옛 이름\n\n낡은 종합'
    expect(buildJ9(paths, '', members, same, NOW).prompt).toContain('옛 이름')
  })

  it('rejects a refusal/pointer body — no junk hub', async () => {
    const paths = await linkedVault('j9-refusal')
    const members = await loadNotes(paths)
    const spec = buildJ9(paths, '', members, null, NOW)
    const effects = await spec.apply(JSON.stringify({ body: '죄송합니다. 도구가 비활성화되어 저장할 수 없습니다.' }))
    expect(effects.join('\n')).toContain('too thin')
    expect((await loadNotes(paths)).filter((n) => n.front.type === 'hub')).toHaveLength(0)
  })

  it('sweep runs J9 over a linked component and lands the hub (conservative skips it)', async () => {
    const canned = {
      J1: '{"type":"note","decay":"slow","body":"# 메모\\n\\n내용."}',
      J2: '{"links":[]}',
      J3: '{"cards":[]}',
      J4: '{"cards":[]}',
      J5: '{"cards":[]}',
      J6: '{"estimates":[]}',
      J7: '{"cards":[]}',
      J8: '# 브리핑\n\n요약.',
      J10: '# 주간 다이제스트\n\n## 이번 주 쌓인 것\n\n- 배포 정리.',
    }

    const conservative = await linkedVault('j9-sweep-conservative')
    await writeFile(join(conservative.inbox, 'memo.md'), '캡처') // ensure executed > 0 either way
    await sweep(conservative, [new MockEngine(canned)], { now: () => NOW, autonomy: 'conservative' })
    expect((await loadNotes(conservative)).filter((n) => n.front.type === 'hub')).toHaveLength(0)

    const paths = await linkedVault('j9-sweep')
    const report = await sweep(paths, [new MockEngine({ ...canned, J9: JSON.stringify({ body: HUB_BODY }) })], {
      now: () => NOW,
    })
    expect(report.failed).toEqual([])
    const hub = (await loadNotes(paths)).find((n) => n.front.type === 'hub')
    expect(hub).toBeDefined()
    expect(hub!.front.derived_from.sort()).toEqual(['n-a', 'n-b', 'n-c', 'n-d'])
  }, 60_000)
})
