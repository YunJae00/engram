import { beforeEach, describe, expect, it } from 'vitest'
import { answerCardWithText, createCard, readCard } from '../src/cards.js'
import { createNote, loadNotes, readNote } from '../src/notes.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// Typing into the nudge is the third way to answer a question, and the
// strongest: the user's sentence becomes a current note superseding every
// note the card was about. These tests pin the grammar — supersession, not
// deletion; the card resolves; a heading is grown for headingless text.

const NOW = new Date('2026-07-31T00:00:00Z')
let paths: VaultPaths

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('card-answer'), { git: false })
})

describe('answerCardWithText', () => {
  it("the typed sentence outranks both sides of a conflict", async () => {
    const a = await createNote(paths, { id: 'n-a', body: '# 원인\n\ndev DB 미적용.', status: 'disputed' }, NOW)
    const b = await createNote(paths, { id: 'n-b', body: '# 원인 조사\n\n운영 DB 미적용.', status: 'disputed' }, NOW)
    const card = await createCard(
      paths,
      { cardType: 'conflict', targets: [a.front.id, b.front.id], rationale: '환경 지목 상충', job: 'J3' },
      NOW,
    )
    await answerCardWithText(paths, card.id, '운영이 맞아 — dev는 이미 적용됨', NOW)

    expect((await readCard(paths, card.id)).status).toBe('approved')
    // Nothing deleted: both originals survive on disk as superseded.
    expect((await readNote(paths, 'n-a')).front.status).toBe('superseded')
    expect((await readNote(paths, 'n-b')).front.status).toBe('superseded')
    const answer = (await loadNotes(paths)).find((n) => n.front.supersedes.includes('n-a'))
    expect(answer).toBeDefined()
    expect(answer!.front.status).toBe('current')
    expect(answer!.front.supersedes.sort()).toEqual(['n-a', 'n-b'])
    expect(answer!.body).toContain('# 운영이 맞아')
    expect(answer!.body).toContain('dev는 이미 적용됨')
  })

  it('refuses an empty answer and a settled card', async () => {
    const a = await createNote(paths, { id: 'n-c', body: '# 하나\n\n본문.' }, NOW)
    const card = await createCard(
      paths,
      { cardType: 'stale', targets: [a.front.id], rationale: '신선도', job: 'J5' },
      NOW,
    )
    await expect(answerCardWithText(paths, card.id, '   ', NOW)).rejects.toThrow('empty')
    await answerCardWithText(paths, card.id, '아직 유효함, 매주 확인 중', NOW)
    await expect(answerCardWithText(paths, card.id, '두 번째 답', NOW)).rejects.toThrow('already')
  })
})
