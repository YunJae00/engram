import { describe, expect, it } from 'vitest'
import { buildJ11 } from '../src/jobs/session-harvest.js'
import type { SessionTurn } from '../src/sessions.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// A conversation is harvested again every time it settles — for hours, as it
// grows. Each call used to start from nothing, so one conclusion reached at
// 05:20 was written again at 05:29 and again at 05:34, in different words.
// Measured on the real vault: three notes about a single design decision inside
// eleven minutes, which the librarian then read as three sources disagreeing
// and turned into questions for the user.
//
// The cure is telling the job what it already kept from THIS conversation.
// Exact titles, straight from its own previous output — no similarity scoring,
// nothing to tune.

const TURNS: SessionTurn[] = [
  { role: 'user', text: '넛지 카드가 포커스를 뺏으면 안 되는데 어떻게 하지', at: '2026-07-30T05:20:00Z' },
  { role: 'assistant', text: 'showInactive로 띄우면 포커스가 안 넘어감', at: '2026-07-30T05:20:30Z' },
]

describe('J11 does not re-harvest what it already kept', () => {
  it('carries the previous titles into the prompt, verbatim', async () => {
    const paths = await initVault(await tmpVaultRoot('harvest-dedupe'), { git: false })
    const kept = ['넛지 카드는 포커스를 뺏지 않는다', '리뷰 큐 질문은 conflict만 즉시 묻는다']
    const job = buildJ11(paths, '', 'strata', TURNS, kept)
    for (const title of kept) expect(job.prompt).toContain(title)
    // …and says what to do about them, or listing them teaches nothing.
    expect(job.prompt).toContain('Do not write any of the above again')
    expect(job.prompt).toContain('an empty array is the correct answer')
  })

  it('says nothing about previous notes on the first harvest of a conversation', async () => {
    const paths = await initVault(await tmpVaultRoot('harvest-first'), { git: false })
    const job = buildJ11(paths, '', 'strata', TURNS)
    expect(job.prompt).not.toContain('이미 남긴 것')
  })

  it('leaves room to correct an earlier note rather than only staying silent', async () => {
    // Silence is the right default, but a session that discovers an earlier
    // conclusion was wrong must be able to say so — otherwise the vault keeps
    // the error forever and the only thing that ever changes is the pile.
    const paths = await initVault(await tmpVaultRoot('harvest-correct'), { git: false })
    const job = buildJ11(paths, '', 'strata', TURNS, ['showInactive 미사용'])
    expect(job.prompt).toContain('Correction')
  })

  it('the same span asks the engine the same question twice (journal skip)', async () => {
    const paths = await initVault(await tmpVaultRoot('harvest-key'), { git: false })
    const a = buildJ11(paths, '', 'strata', TURNS, [])
    const b = buildJ11(paths, '', 'strata', TURNS, [])
    expect(a.inputKey).toBe(b.inputKey)
  })
})
