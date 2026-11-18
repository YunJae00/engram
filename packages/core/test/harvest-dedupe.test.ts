import { describe, expect, it } from 'vitest'
import { buildJ11 } from '../src/jobs/session-harvest.js'
import type { SessionTurn } from '../src/sessions.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const TURNS: SessionTurn[] = [
  { role: 'user', text: '넛지 카드가 포커스를 뺏으면 안 되는데 어떻게 하지', at: '2026-07-30T05:20:00Z' },
  { role: 'assistant', text: 'showInactive로 띄우면 포커스가 안 넘어감', at: '2026-07-30T05:20:30Z' },
]

describe('J11 does not re-harvest what it already kept', () => {
  it('rejects malformed output instead of acknowledging and losing the pending span', async () => {
    const paths = await initVault(await tmpVaultRoot('harvest-invalid'), { git: false })
    const job = buildJ11(paths, '', 'work', TURNS)
    for (const output of ['{}', '{"notes":null}', '{"notes":[{"title":"Missing body"}]}'])
      await expect(job.apply(output)).rejects.toThrow('Invalid session harvest response')
    await expect(job.apply('{"notes":[]}')).resolves.toEqual(['nothing worth keeping'])
    expect(job.prompt).toContain(TURNS[0]!.at)
  })
  it('carries the previous titles into the prompt, verbatim', async () => {
    const paths = await initVault(await tmpVaultRoot('harvest-dedupe'), { git: false })
    const kept = ['넛지 카드는 포커스를 뺏지 않는다', '리뷰 큐 질문은 conflict만 즉시 묻는다']
    const job = buildJ11(paths, '', 'strata', TURNS, kept)
    for (const title of kept) expect(job.prompt).toContain(title)
    expect(job.prompt).toContain('Do not write any of the above again')
    expect(job.prompt).toContain('an empty array is the correct answer')
  })

  it('says nothing about previous notes on the first harvest of a conversation', async () => {
    const paths = await initVault(await tmpVaultRoot('harvest-first'), { git: false })
    const job = buildJ11(paths, '', 'strata', TURNS)
    expect(job.prompt).not.toContain('이미 남긴 것')
  })

  it('leaves room to correct an earlier note rather than only staying silent', async () => {
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
