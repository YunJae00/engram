import { describe, expect, it } from 'vitest'
import {
  addReviewRule,
  evaluate,
  parseReviewRules,
  routineCardExpired,
  serializeReviewRules,
  type ReviewAction,
  type ReviewRule,
  type ReviewRuleKind,
} from '../src/review-rules.js'

const ACTION = { operation: 'send', target: 'mail:boss@example.com' }
const ask: ReviewRule = { kind: 'ask-first', ...ACTION }
const allow: ReviewRule = { kind: 'allow', ...ACTION }

function fill(kind: ReviewRuleKind, n: number): ReviewRule[] {
  return Array.from({ length: n }, (_, i) => ({ kind, operation: 'send', target: `mail:${kind}-${i}@example.com` }))
}

function withIterator<T>(items: T[], yielded: T[]): T[] {
  Object.defineProperty(items, Symbol.iterator, { value: () => yielded[Symbol.iterator]() })
  return items
}

describe('review rules', () => {
  it('ask-first wins on conflict', () => {
    expect(evaluate([ask, allow], ACTION)).toBe('ask')
    expect(evaluate([allow, ask], ACTION)).toBe('ask')
    expect(evaluate([allow], ACTION)).toBe('allow')
    expect(evaluate([allow], { operation: 'send', target: 'mail:other@example.com' })).toBe('ask')
    expect(evaluate([], { operation: 'send', target: 'x' })).toBe('ask')
    expect(evaluate([], { operation: 'submit', target: 'x' })).toBe('ask')
    expect(evaluate([], { operation: 'read', target: 'x' })).toBe('allow')
    expect(evaluate([{ kind: 'ask-first', operation: 'read', target: 'x' }], { operation: 'read', target: 'x' })).toBe('ask')
    expect(evaluate([{ ...allow, extra: 1 } as ReviewRule], ACTION)).toBe('ask')
    expect(evaluate([allow], { operation: 'Send', target: ACTION.target })).toBe('ask')
  })

  it('max 20 per kind', () => {
    const full = [...fill('ask-first', 20), ...fill('allow', 20)]
    const snapshot = JSON.stringify(full)
    expect(addReviewRule(full, full[0] as ReviewRule)).toEqual(full)
    expect(() => addReviewRule(full, { kind: 'allow', operation: 'send', target: 'new' })).toThrow()
    expect(() => addReviewRule(full, { kind: 'ask-first', operation: 'send', target: 'new' })).toThrow()
    expect(JSON.stringify(full)).toBe(snapshot)
    expect(addReviewRule(fill('allow', 19), { kind: 'allow', operation: 'send', target: 'new' })).toHaveLength(20)
    const over = [...fill('allow', 21)]
    expect(() => serializeReviewRules(over)).toThrow()
    expect(() => parseReviewRules(JSON.stringify(over))).toThrow()
    expect(evaluate(over, { operation: 'send', target: 'mail:allow-20@example.com' })).toBe('ask')
    expect(evaluate(over, { operation: 'read', target: 'x' })).toBe('ask')
    expect(parseReviewRules(serializeReviewRules(full))).toEqual(full)
  })

  it('routine card expires after 30 min', () => {
    const createdAt = JSON.parse(JSON.stringify('2026-11-10T09:00:00.000Z')) as string
    const t0 = Date.parse(createdAt)
    expect(routineCardExpired(createdAt, t0)).toBe(false)
    expect(routineCardExpired(createdAt, t0 + 30 * 60_000 - 1)).toBe(false)
    expect(routineCardExpired(createdAt, t0 + 30 * 60_000)).toBe(true)
    expect(routineCardExpired(createdAt, t0 + 60 * 60_000)).toBe(true)
    expect(routineCardExpired(createdAt, t0 - 1)).toBe(true)
    expect(routineCardExpired('2026-11-10T09:00:00', t0)).toBe(true)
    expect(routineCardExpired('2026-02-30T09:00:00.000Z', Date.parse('2026-03-02T09:00:00.000Z'))).toBe(true)
    expect(routineCardExpired('2026-11-10T24:00:00Z', t0)).toBe(true)
    expect(routineCardExpired('not a date', t0)).toBe(true)
    expect(routineCardExpired(createdAt, Number.NaN)).toBe(true)
    expect(routineCardExpired(createdAt, Number.POSITIVE_INFINITY)).toBe(true)
  })

  it('createdAt must be canonical toISOString', () => {
    const now = Date.parse('2026-11-10T09:10:00.000Z')
    for (const bad of ['2026-02-30T09:00:00.000Z', '2026-11-10T09:00:00+09:00', '2026-11-10T09:00:00Z', '', 'not a date', '2026-11-10T24:00:00.000Z']) {
      expect(routineCardExpired(bad, now)).toBe(true)
    }
    expect(routineCardExpired('2026-03-02T09:00:00.000Z', Date.parse('2026-03-02T09:00:00.000Z'))).toBe(false)
    expect(routineCardExpired('2026-02-30T09:00:00.000Z', Date.parse('2026-03-02T09:00:00.000Z'))).toBe(true)
    expect(routineCardExpired('2026-11-10T09:20:00.000Z', now)).toBe(true)
    expect(routineCardExpired('2026-11-10T09:00:00.000Z', Number.NaN)).toBe(true)
    expect(routineCardExpired(42 as unknown as string, now)).toBe(true)
    for (const live of ['2026-11-10T09:00:00.000Z', '0000-02-29T12:00:00.000Z']) {
      expect(routineCardExpired(live, Date.parse(live))).toBe(false)
    }
    expect(routineCardExpired(new Date(now).toISOString(), now)).toBe(false)
  })

  it('malformed input fails closed', () => {
    const throwing = { kind: 'allow', target: ACTION.target, get operation(): string { throw new Error('boom') } }
    expect(evaluate([throwing as unknown as ReviewRule], ACTION)).toBe('ask')
    const actionGetter = { target: 'x', get operation(): string { throw new Error('boom') } }
    expect(evaluate([], actionGetter as unknown as ReviewAction)).toBe('ask')
    const arrayAction = Object.assign([], { operation: 'read', target: 'x' })
    expect(evaluate([{ kind: 'allow', operation: 'read', target: 'x' }], arrayAction as unknown as ReviewAction)).toBe('ask')
    let reads = 0
    const flipping = { kind: 'allow', target: ACTION.target, get operation(): string { reads += 1; return reads === 1 ? 'send' : 'Send' } }
    expect(evaluate([flipping as unknown as ReviewRule], ACTION)).toBe('allow')
    expect(() => addReviewRule([throwing as unknown as ReviewRule], allow)).toThrow()
  })

  it('round trip and invalid rows', () => {
    expect(parseReviewRules('[]')).toEqual([])
    expect(parseReviewRules(serializeReviewRules([ask, allow]))).toEqual([ask, allow])
    expect(() => parseReviewRules('{')).toThrow()
    expect(() => parseReviewRules('{}')).toThrow()
    expect(() => parseReviewRules(JSON.stringify([allow, { ...allow, extra: 1 }]))).toThrow()
    expect(() => parseReviewRules(JSON.stringify([{ ...allow, kind: 'deny' }]))).toThrow()
    expect(() => parseReviewRules(JSON.stringify([{ ...allow, operation: 'Send' }]))).toThrow()
    expect(() => parseReviewRules(JSON.stringify([{ ...allow, target: ' x' }]))).toThrow()
    expect(() => parseReviewRules(JSON.stringify([{ ...allow, target: '' }]))).toThrow()
  })

  it('keeps inputs independent across interleaved calls', () => {
    const base: ReviewRule[] = [allow]
    const a = addReviewRule(base, { kind: 'allow', operation: 'submit', target: 'form:a' })
    const b = addReviewRule(base, ask)
    expect(base).toEqual([allow])
    expect(evaluate(a, ACTION)).toBe('allow')
    expect(evaluate(b, ACTION)).toBe('ask')
    expect(evaluate(a, { operation: 'submit', target: 'form:a' })).toBe('allow')
    expect(evaluate(b, { operation: 'submit', target: 'form:a' })).toBe('ask')
  })

  it('custom iterator cannot hide indexed rules', () => {
    const allows = fill('allow', 21)
    const hidden = withIterator(allows.slice(), [allows[0] as ReviewRule])
    expect([...hidden]).toHaveLength(1)
    expect(evaluate(hidden, { operation: 'send', target: 'mail:allow-0@example.com' })).toBe('ask')
    expect(evaluate(hidden, { operation: 'read', target: 'x' })).toBe('ask')
    expect(() => addReviewRule(hidden, { kind: 'allow', operation: 'read', target: 'x' })).toThrow()
    expect(() => serializeReviewRules(hidden)).toThrow()

    const conflict = withIterator([ask, allow], [allow])
    expect([...conflict]).toEqual([allow])
    expect(evaluate(conflict, ACTION)).toBe('ask')
    expect(addReviewRule(conflict, { kind: 'allow', operation: 'read', target: 'x' })).toContainEqual(ask)

    const arrayLike = { length: 1, 0: allow }
    expect(evaluate(arrayLike as unknown as ReviewRule[], ACTION)).toBe('ask')
    expect(() => addReviewRule(arrayLike as unknown as ReviewRule[], allow)).toThrow()

    const huge: ReviewRule[] = []
    huge.length = 2 ** 32 - 1
    expect(evaluate(huge, { operation: 'read', target: 'x' })).toBe('ask')
  })
})
