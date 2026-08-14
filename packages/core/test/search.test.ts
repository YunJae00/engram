import { beforeAll, describe, expect, it } from 'vitest'
import { createNote } from '../src/notes.js'
import { buildIndex, searchIndex, searchIndexStrict } from '../src/search.js'
import type { Note } from '../src/schema.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

let paths: VaultPaths
let notes: Note[]

beforeAll(async () => {
  paths = await initVault(await tmpVaultRoot('search'), { git: false })
  notes = [
    await createNote(paths, { body: '# 배포 절차\n\nCI 파이프라인으로 배포한다.' }),
    await createNote(paths, { body: '# 요금제\n\n프로 요금제 가격 정책.' }),
  ]
})

describe('fulltext index (minisearch)', () => {
  it('finds notes by body keyword', () => {
    const index = buildIndex(notes)
    const hits = searchIndex(index, '파이프라인')
    expect(hits.map((h) => h.id)).toEqual([notes[0]!.front.id])
  })

  it('matches a run-on Korean compound via CJK bigrams', async () => {
    const knee = await createNote(paths, { body: '# 무릎 통증 기록\n\n러닝 후 계단에서 아프다.' })
    const index = buildIndex([...notes, knee])
    expect(searchIndex(index, '무릎통증 어떡하지').map((h) => h.id)).toContain(knee.front.id)
  })

  it('plain (cjkNgrams:false) index keeps whitespace-token behaviour for J7', async () => {
    const knee = await createNote(paths, { body: '# 무릎 통증 기록\n\n러닝 후 계단에서 아프다.' })
    const plain = buildIndex([...notes, knee], { cjkNgrams: false })
    expect(searchIndex(plain, '무릎통증').map((h) => h.id)).not.toContain(knee.front.id)
  })

  describe('strict search (capture echo)', () => {
    it('drops a one-common-word match that recall search surfaces', async () => {
      const retention = await createNote(paths, {
        body: '# 다음 분기 목표: 리텐션 중심\n\n팀장이 다음 분기 목표를 신규 가입에서 리텐션 중심으로 전환함.',
      })
      const index = buildIndex([...notes, retention])
      const query = '지난주에 산 원두는 산미가 너무 강했음. 다음엔 브라질 다크로'
      expect(searchIndex(index, query).map((h) => h.id)).toContain(retention.front.id)
      expect(searchIndexStrict(index, query).map((h) => h.id)).not.toContain(retention.front.id)
    })

    it('keeps a genuinely related note', async () => {
      const retention = await createNote(paths, {
        body: '# 다음 분기 목표: 리텐션 중심\n\n팀장이 다음 분기 목표를 신규 가입에서 리텐션 중심으로 전환함.',
      })
      const index = buildIndex([...notes, retention])
      const hits = searchIndexStrict(index, '다음 분기 리텐션 목표가 뭐였지')
      expect(hits.map((h) => h.id)).toContain(retention.front.id)
    })

    it('still matches short two-word queries (lower term bar)', async () => {
      const knee = await createNote(paths, { body: '# 무릎 통증 기록\n\n러닝 후 계단에서 아프다.' })
      const index = buildIndex([...notes, knee])
      expect(searchIndexStrict(index, '무릎 통증').map((h) => h.id)).toContain(knee.front.id)
    })

    it('single-char tokens never carry a match (화/목/토 → 목표 prefix noise)', async () => {
      const retention = await createNote(paths, {
        body: '# 리텐션 중심 목표 공지\n\n팀장이 다음 분기 목표를 신규 가입에서 리텐션 중심으로 전환함.',
      })
      const index = buildIndex([...notes, retention])
      const query = '운동은 화/목/토 아침으로 고정하기로 함'
      expect(searchIndexStrict(index, query).map((h) => h.id)).not.toContain(retention.front.id)
    })
  })
})
