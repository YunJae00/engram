import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ruleFor } from 'core'
import { approvalsStore, reviewRuleInput } from '../src/main/approvals.js'

// Standing approvals live in one small file; a rule leaves with its routine.
describe('approvalsStore', () => {
  it('keeps a rule across reads, forgets one, and retires a routine', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-approvals-'))
    const store = approvalsStore(dir)
    const a = ruleFor({ routineId: 'rt-1', kind: 'submit', host: 'a.example.com', fieldLabels: ['Entry'] })
    const b = ruleFor({ routineId: 'rt-2', kind: 'submit', host: 'b.example.com', fieldLabels: ['Entry'] })
    await store.add(a)
    await store.add(b)
    await store.add(a)
    expect((await store.list()).map((r) => r.routineId)).toEqual(['rt-1', 'rt-2'])
    expect(await approvalsStore(dir).list()).toHaveLength(2)
    await store.forget(a.fingerprint)
    expect((await store.list()).map((r) => r.routineId)).toEqual(['rt-2'])
    await store.retire('rt-2')
    expect(await store.list()).toEqual([])
  })

  it('reads nothing from a missing or broken file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engram-approvals-'))
    expect(await approvalsStore(dir).list()).toEqual([])
  })

  const fresh = () => mkdtemp(join(tmpdir(), 'engram-approvals-'))
  const allow = (target: string) => ({ kind: 'allow' as const, operation: 'submit' as const, target })
  const askFirst = (target: string) => ({ kind: 'ask-first' as const, operation: 'submit' as const, target })

  it('rules persist and old routine rules still load', async () => {
    const dir = await fresh()
    await approvalsStore(dir).addReviewRule(askFirst('example.com'))
    await approvalsStore(dir).addReviewRule(allow('docs.example.org'))
    expect(await approvalsStore(dir).reviewRules()).toEqual([askFirst('example.com'), allow('docs.example.org')])
    const old = await fresh()
    const routine = ruleFor({ routineId: 'rt-1', kind: 'submit', host: 'a.example.com', fieldLabels: ['Entry'] })
    await writeFile(join(old, 'approvals.json'), JSON.stringify({ rules: [routine] }))
    expect(await approvalsStore(old).list()).toEqual([routine])
    expect(await approvalsStore(old).reviewRules()).toEqual([])
  })

  it('review rules: add, remove, cap 20 per kind and dedupe', async () => {
    const dir = await fresh()
    const store = approvalsStore(dir)
    const file = join(dir, 'approvals.json')
    await store.removeReviewRule(allow('example.com'))
    await expect(access(file)).rejects.toThrow()
    for (let i = 0; i < 20; i++) await store.addReviewRule(allow(`s${i}.example.com`))
    const before = await readFile(file)
    await expect(store.addReviewRule(allow('s20.example.com'))).rejects.toThrow()
    expect(await readFile(file)).toEqual(before)
    expect(await store.addReviewRule(askFirst('example.com'))).toHaveLength(21)
    expect(await store.addReviewRule(askFirst('example.com'))).toHaveLength(21)
    const full = await readFile(file)
    expect(await store.removeReviewRule(askFirst('absent.example.com'))).toHaveLength(21)
    expect(await readFile(file)).toEqual(full)
    expect(await store.removeReviewRule(askFirst('example.com'))).toHaveLength(20)
    const other = await fresh()
    const both = approvalsStore(other)
    await Promise.all([both.addReviewRule(allow('a.example.com')), both.addReviewRule(askFirst('b.example.com'))])
    expect(await approvalsStore(other).reviewRules()).toEqual([allow('a.example.com'), askFirst('b.example.com')])
  })

  it('review-rule writes keep every other key verbatim and refuse an unreadable file', async () => {
    const dir = await fresh()
    const file = join(dir, 'approvals.json')
    const routine = ruleFor({ routineId: 'rt-1', kind: 'submit', host: 'a.example.com', fieldLabels: ['Entry'] })
    const odd = { routineId: 7, junk: true }
    await writeFile(file, JSON.stringify({ rules: [routine, odd], extra: { keep: [1, 'two'] } }))
    await approvalsStore(dir).addReviewRule(allow('example.com'))
    const after = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(JSON.stringify(after['rules'])).toBe(JSON.stringify([routine, odd]))
    expect(JSON.stringify(after['extra'])).toBe(JSON.stringify({ keep: [1, 'two'] }))
    expect(after['reviewRules']).toEqual([allow('example.com')])
    for (const bad of ['{not json', '[]', JSON.stringify({ reviewRules: 'x' })]) {
      await writeFile(file, bad)
      const store = approvalsStore(dir)
      await expect(store.addReviewRule(allow('b.example.com'))).rejects.toThrow()
      await expect(store.removeReviewRule(allow('example.com'))).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(bad)
    }
  })

  it('review-rule input accepts only {kind, target} with a normalized host', () => {
    expect(reviewRuleInput({ kind: 'allow', target: 'example.com' })).toEqual(allow('example.com'))
    const rejects: unknown[] = [
      { kind: 'allow', target: 'example.com', operation: 'submit' }, { kind: 'allow' }, { target: 'example.com' },
      { kind: 'deny', target: 'example.com' }, { kind: 'allow', target: '' }, { kind: 'allow', target: ' example.com' },
      { kind: 'allow', target: 'Example.com' }, { kind: 'allow', target: 'example.com:8080' }, { kind: 'allow', target: 'https://example.com' },
      { kind: 'allow', target: 'example.com/path' }, { kind: 'allow', target: 'user@example.com' },
      { kind: 'allow', target: `${'a'.repeat(250)}.com` }, { kind: 'allow', target: 42 }, null, 'example.com', [],
    ]
    for (const value of rejects) expect(() => reviewRuleInput(value)).toThrow()
  })
})
