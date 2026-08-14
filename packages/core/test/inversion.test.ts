import { describe, expect, it } from 'vitest'
import { approveCard, listCards } from '../src/cards.js'
import { MockEngine } from '../src/engine/mock.js'
import { createNote, readNote } from '../src/notes.js'
import { sweep } from '../src/jobs/sweep.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const engine = new MockEngine({
  J2: '{"links":[]}',
  J3: '{"cards":[]}',
  J4: '{"cards":[]}',
  J5: '{"cards":[]}',
  J6: '{"estimates":[]}',
  J7: '{"cards":[]}',
  J8: '# Brief\n\nnothing new.',
  J10: '# Weekly digest\n\n## What accumulated\n\n- pricing notes.',
})

describe('supersede/chronology inversion → card ⑥ (M5)', () => {
  it('sweep raises a chronology card and approval re-dates + pins', async () => {
    const paths = await initVault(await tmpVaultRoot('inversion'), { git: false })
    await createNote(paths, {
      id: 'n-old-0001',
      body: '# Pricing v1\n\nOld pricing.',
      status: 'superseded',
      happened_at: '2026-05-01',
    })
    await createNote(paths, {
      id: 'n-new-0001',
      body: '# Pricing v2\n\nNew pricing.',
      supersedes: ['n-old-0001'],
      happened_at: '2026-04-01', // earlier than what it supersedes — inverted
    })

    await sweep(paths, [engine])
    const card = (await listCards(paths, 'proposed')).find((c) => c.cardType === 'chronology')
    expect(card).toBeDefined()
    expect(card!.targets).toEqual(['n-new-0001', 'n-old-0001'])

    await approveCard(paths, card!.id)
    const fixed = await readNote(paths, 'n-new-0001')
    expect(fixed.front.happened_at).toContain('2026-05-02') // day after the superseded note
    expect(fixed.front.timeline).toBe('pinned')
  })

  it('a second sweep does not duplicate the card', async () => {
    const paths = await initVault(await tmpVaultRoot('inversion-idem'), { git: false })
    await createNote(paths, { id: 'n-old-0002', body: '# A', status: 'superseded', happened_at: '2026-05-01' })
    await createNote(paths, { id: 'n-new-0002', body: '# B', supersedes: ['n-old-0002'], happened_at: '2026-04-01' })
    await sweep(paths, [engine])
    await sweep(paths, [engine])
    const cards = (await listCards(paths)).filter((c) => c.cardType === 'chronology')
    expect(cards).toHaveLength(1)
  })
})
