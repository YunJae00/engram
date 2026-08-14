import { beforeEach, describe, expect, it } from 'vitest'
import { createNote, writeNote } from '../src/notes.js'
import { traceNote } from '../src/trace.js'
import { initVault, loadNotes, type VaultPaths } from '../src/index.js'
import { tmpVaultRoot } from './helpers.js'

// link_reasons is J2's field — written onto an existing note, never through
// createNote. The tests wire it the same way the librarian does.
async function link(paths: VaultPaths, from: string, to: string, reason: string) {
  const notes = await loadNotes(paths)
  const note = notes.find((n) => n.front.id === from)!
  note.front.derived_from = [...new Set([...note.front.derived_from, to])]
  note.front.link_reasons = { ...note.front.link_reasons, [to]: reason }
  await writeNote(paths, note)
}

// engram_trace renders one memory's neighborhood as a walkable map — edges
// labeled with the librarian's WHY, lineage in both directions, the topic
// hub, and folder siblings. These tests pin the map's grammar: everything an
// agent needs to walk (ids, arrows, labels) and nothing that belongs to
// engram_context (bodies).

const NOW = new Date('2026-07-31T00:00:00Z')
let paths: VaultPaths

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('trace'), { git: false })
})

describe('traceNote', () => {
  it('draws links out and in, each wearing its reason', async () => {
    await createNote(paths, { id: 'n-b', body: '# 담당파트너 반영\n\n본문.' }, NOW)
    await createNote(paths, { id: 'n-a', body: '# Team owner는 1명\n\n본문.', context: 'chatx' }, NOW)
    await createNote(paths, { id: 'n-c', body: '# 스코프 게이트\n\n본문.' }, NOW)
    await link(paths, 'n-a', 'n-b', 'team 유니크 제약이 owner를 1명으로 제한')
    await link(paths, 'n-c', 'n-a', '같은 팀 구조 전제')
    const map = traceNote(await loadNotes(paths), 'n-a')!
    expect(map).toContain('folder: chatx')
    expect(map).toContain('→ [담당파트너 반영] (n-b')
    expect(map).toContain('team 유니크 제약이 owner를 1명으로 제한')
    expect(map).toContain('← [스코프 게이트] (n-c')
    expect(map).toContain('같은 팀 구조 전제')
    // A map, not a dump: bodies never travel.
    expect(map).not.toContain('본문')
  })

  it('walks the supersede lineage both ways and names the version that speaks', async () => {
    await createNote(paths, { id: 'n-v1', body: '# 결정 v1\n\n본문.', status: 'superseded' }, NOW)
    await createNote(paths, { id: 'n-v2', body: '# 결정 v2\n\n본문.', status: 'superseded', supersedes: ['n-v1'] }, NOW)
    await createNote(paths, { id: 'n-v3', body: '# 결정 v3\n\n본문.', supersedes: ['n-v2'] }, NOW)
    const notes = await loadNotes(paths)
    const midway = traceNote(notes, 'n-v2')!
    expect(midway).toContain('replaces → [결정 v1] (n-v1')
    expect(midway).toContain('replaced by → [결정 v3] (n-v3')
    expect(midway).toContain('this note is history')
    // The current version knows its whole past, transitively.
    const head = traceNote(notes, 'n-v3')!
    expect(head).toContain('n-v2')
    expect(head).toContain('n-v1')
    expect(head).not.toContain('replaced by')
  })

  it('finds the topic hub and folder siblings, capped', async () => {
    await createNote(paths, { id: 'n-seed', body: '# 씨앗\n\n본문.', context: 'novel' }, NOW)
    await createNote(paths, { id: 'n-hub', body: '# 소설 세계관\n\n종합.', type: 'hub' }, NOW)
    await link(paths, 'n-hub', 'n-seed', '세계관 멤버')
    for (let i = 0; i < 7; i++) {
      await createNote(paths, { id: `n-sib-${i}`, body: `# 장면 ${i}\n\n본문.`, context: 'novel' }, NOW)
    }
    const map = traceNote(await loadNotes(paths), 'n-seed')!
    expect(map).toContain('Topic hub: [소설 세계관] (n-hub')
    expect(map).toContain('Same folder "novel" (7 more)')
    expect(map).toContain('… +2 more')
  })

  it('a lone memory still answers, honestly', async () => {
    await createNote(paths, { id: 'n-alone', body: '# 혼자\n\n본문.' }, NOW)
    const map = traceNote(await loadNotes(paths), 'n-alone')!
    expect(map).toContain('No connections yet')
    expect(traceNote(await loadNotes(paths), 'n-ghost')).toBeNull()
  })
})
