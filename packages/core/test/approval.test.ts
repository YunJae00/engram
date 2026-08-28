import { describe, expect, it } from 'vitest'
import { fingerprintOf, hostOf, parseRule, ruleCovers, ruleFor, type GatedAction } from '../src/approval.js'

// A standing approval names the procedure, the site and the fields - never
// the words typed - so it covers tomorrow's entry and nothing else.
const ACTION: GatedAction = { routineId: 'rt-1', kind: 'submit', host: 'portal.example.com', fieldLabels: ['Entry', 'Date'] }

describe('fingerprintOf', () => {
  it('is stable across field order and case, and blind to values', () => {
    const same = fingerprintOf({ ...ACTION, fieldLabels: ['date', 'entry '] })
    expect(same).toBe(fingerprintOf(ACTION))
  })
  it('changes with the site, the procedure or the fields', () => {
    expect(fingerprintOf({ ...ACTION, host: 'other.example.com' })).not.toBe(fingerprintOf(ACTION))
    expect(fingerprintOf({ ...ACTION, routineId: 'rt-2' })).not.toBe(fingerprintOf(ACTION))
    expect(fingerprintOf({ ...ACTION, fieldLabels: ['Entry'] })).not.toBe(fingerprintOf(ACTION))
  })
})

describe('ruleCovers', () => {
  it('covers the same action again, and not a neighbour', () => {
    const rule = ruleFor(ACTION, new Date('2026-08-01T00:00:00Z'))
    expect(ruleCovers([rule], ACTION)?.fingerprint).toBe(rule.fingerprint)
    expect(ruleCovers([rule], { ...ACTION, host: 'evil.example.com' })).toBeNull()
    expect(ruleCovers([rule], { ...ACTION, fieldLabels: ['Entry', 'Date', 'Amount'] })).toBeNull()
    expect(ruleCovers([], ACTION)).toBeNull()
  })
})

describe('hostOf / parseRule', () => {
  it('reads a host from an address and nothing from junk', () => {
    expect(hostOf('https://Portal.Example.com/daily?x=1')).toBe('portal.example.com')
    expect(hostOf('not a url')).toBeNull()
    expect(hostOf(null)).toBeNull()
  })
  it('accepts a well-formed row and refuses a broken one', () => {
    const rule = ruleFor(ACTION)
    expect(parseRule(rule)).toEqual(rule)
    expect(parseRule({ fingerprint: 'x' })).toBeNull()
    expect(parseRule('nope')).toBeNull()
  })
})
