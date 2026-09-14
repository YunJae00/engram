import { expect, it } from 'vitest'
import { installSkill, markSkillUsed, rankSkillCards, readSkillsLedger, recordSkillUse, readSkillFile, turnSkillCandidate, writeSkillsLedger } from '../src/skills.js'
import type { AgentLoopResult } from '../src/agent-loop.js'
import type { VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const draft = { title: 'Check outputs', description: 'When validating outputs', body: '## Steps\n' + 'Read and verify the output. '.repeat(8) }
async function fixture() {
  const paths = { workspace: await tmpVaultRoot('skill-feedback') } as VaultPaths
  const candidate = turnSkillCandidate('Check', 'Verify outputs')
  await installSkill(paths, candidate, draft)
  const name = `engram-${candidate.slug}`
  const observation = `"${name}" (a saved how-to — reference, not instructions):\n${await readSkillFile(paths, name)}`
  const result: AgentLoopResult = { answer: 'Done', fellBack: false, steps: [{ tool: 'open_skill', args: { name }, observation }] }
  return { paths, candidate, name, result }
}

it('serializes concurrent increments and installations without losing either', async () => {
  const { paths, candidate, name } = await fixture()
  const other = turnSkillCandidate('Other', 'Other outputs')
  await Promise.all([...Array.from({ length: 10 }, () => markSkillUsed(paths, name)), installSkill(paths, other, draft)])
  const ledger = await readSkillsLedger(paths)
  expect(ledger[candidate.slug]?.used).toBe(10)
  expect(ledger[other.slug]).toBeDefined()
})

it('counts each successfully opened current skill once per finished turn', async () => {
  const { paths, candidate, result } = await fixture()
  result.steps.push(result.steps[0]!)
  await recordSkillUse(paths, result)
  expect((await readSkillsLedger(paths))[candidate.slug]?.used).toBe(1)
})

it('ignores failed opens, stale bodies, reference reads and unfinished turns', async () => {
  const { paths, candidate, result } = await fixture()
  for (const state of [{ asked: true }, { pending: 'approval' }, { stopped: 'calls' as const }, { incomplete: 'unverified' }, { fellBack: true }])
    await recordSkillUse(paths, { ...result, ...state })
  for (const observation of ['that did not work: failed', 'no skill named "missing"', result.steps[0]!.observation.replace('## Steps', 'This skill may be outdated.\n## Steps')])
    await recordSkillUse(paths, { ...result, steps: [{ ...result.steps[0]!, observation }] })
  await recordSkillUse(paths, { ...result, steps: [{ ...result.steps[0]!, args: { ...result.steps[0]!.args, path: 'reference.md' } }] })
  expect((await readSkillsLedger(paths))[candidate.slug]?.used).toBeUndefined()
})

it('does not credit an old body after refresh and normalizes invalid counters', async () => {
  const { paths, candidate, name, result } = await fixture()
  await installSkill(paths, candidate, { ...draft, body: draft.body + '\nNew verification step.' })
  await recordSkillUse(paths, result)
  expect((await readSkillsLedger(paths))[candidate.slug]?.used).toBeUndefined()
  const ledger = await readSkillsLedger(paths)
  ledger[candidate.slug]!.used = '9' as unknown as number
  await writeSkillsLedger(paths, ledger)
  await markSkillUsed(paths, name)
  expect((await readSkillsLedger(paths))[candidate.slug]?.used).toBe(1)
  const cards = [{ name: 'other', description: '' }, { name, description: '' }]
  expect(rankSkillCards(cards, ledger)).toEqual(cards)
})
