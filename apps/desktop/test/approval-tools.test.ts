import { expect, it } from 'vitest'
import type { ApprovalRule } from 'core'
import { standingApprovalsTool } from '../src/main/approval-tools.js'

const rule = (fingerprint: string, host: string): ApprovalRule => ({ fingerprint, routineId: 'r1', host, createdAt: '2026-11-01T00:00:00.000Z' }) as ApprovalRule

function store(initial: ApprovalRule[]) {
  let rules = [...initial]
  return { list: async () => rules, forget: async (fingerprint: string) => { rules = rules.filter(one => one.fingerprint !== fingerprint) }, left: () => rules.map(one => one.fingerprint) }
}

it('lists what the person allowed and takes a site back, every rule for it, without adding anything', async () => {
  const kept = store([rule('a', 'www.example.com'), rule('b', 'example.com'), rule('c', 'other.kr')])
  const tool = standingApprovalsTool(kept)
  expect(JSON.parse(await tool.run({ action: 'list' }, {} as never) as string).allowed).toEqual([
    { site: 'www.example.com', since: '2026-11-01' }, { site: 'example.com', since: '2026-11-01' }, { site: 'other.kr', since: '2026-11-01' },
  ])
  expect(JSON.parse(await tool.run({ action: 'forget', site: 'https://Example.com/login' }, {} as never) as string)).toEqual({ forgotten: 'example.com', count: 2 })
  expect(kept.left()).toEqual(['c'])
  await expect(tool.run({ action: 'forget', site: 'example.com' }, {} as never)).rejects.toThrow(/No standing approval/)
  await expect(tool.run({ action: 'add', site: 'evil.com' }, {} as never)).rejects.toThrow(/"list" or "forget"/)
  expect(kept.left()).toEqual(['c'])
})
