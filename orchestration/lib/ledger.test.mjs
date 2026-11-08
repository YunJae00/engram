import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL, fileURLToPath } from 'node:url'
import {
  currentAttempt, decide, followup, isHard, isTerminal, loadLedger, loadRoles, rung, saveLedger, transition,
} from './ledger.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const roles = loadRoles(repoRoot)
const base = { id: 'x', area: 'ts', difficulty: 'easy', bounces: 0, allowedFiles: ['packages/core/src/a.ts'], attempts: [] }
const temps = []
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-ledger-'))
  temps.push(root)
  return root
}

// The loop exports ENGRAM_MAX_BOUNCES; these tests pick their own cap.
beforeEach(() => vi.stubEnv('ENGRAM_MAX_BOUNCES', undefined))

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('roles', () => {
  it('parses the single json block in roles.md', () => {
    expect(roles.baseBranch).toBe('next')
    expect(roles.ladder.ts).toHaveLength(3)
    for (const area of ['ts', 'native']) {
      expect(roles.ladder[area].every((rung) => rung.implementer === 'claude-local' && rung.verifier === 'codex-local')).toBe(true)
    }
    expect(roles.models.claude.implement).toBe('claude-opus-5-5')
    expect(roles.models.claude.verify).toBe('claude-opus-5-5')
    expect(roles.models.codex).toBe('gpt-6-sol')
  })

  it('throws when roles.md has no json block', () => {
    const root = tempRoot()
    saveLedger(root, { batch: 'b', items: [] })
    writeFileSync(join(root, 'orchestration/roles.md'), '# Roles\n\nno config here\n')
    expect(() => loadRoles(root)).toThrow(/exactly one json block, found 0/)
  })
})

describe('transition', () => {
  it('moves along a valid edge', () => {
    const item = { ...base, state: 'queued' }
    expect(transition(item, 'briefed').state).toBe('briefed')
    transition(item, 'implementing')
    transition(item, 'implemented')
    transition(item, 'verifying')
    transition(item, 'bounced')
    expect(transition(item, 'briefed').state).toBe('briefed')
  })

  it('throws on an edge not in the state list', () => {
    expect(() => transition({ ...base, state: 'queued' }, 'merged')).toThrow(/queued -> merged/)
    expect(() => transition({ ...base, state: 'reverted' }, 'briefed')).toThrow()
    expect(() => transition({ ...base, state: 'nope' }, 'briefed')).toThrow()
  })

  it('marks terminal states', () => {
    for (const state of ['integrated', 'blocked', 'needs_human', 'reverted', 'released']) expect(isTerminal(state)).toBe(true)
    for (const state of ['queued', 'merged', 'bounced', 'verifying']) expect(isTerminal(state)).toBe(false)
  })
})

describe('ladder', () => {
  it('picks the rung by bounce count and returns null when exhausted', () => {
    expect(rung(base, roles)).toEqual({ implementer: 'claude-local', verifier: 'codex-local' })
    expect(rung({ ...base, bounces: 2 }, roles)).toEqual({ implementer: 'claude-local', verifier: 'codex-local' })
    expect(rung({ ...base, bounces: 3 }, roles)).toBeNull()
  })

  it('stops at ENGRAM_MAX_BOUNCES when the loop sets it', () => {
    vi.stubEnv('ENGRAM_MAX_BOUNCES', '2')
    expect(rung({ ...base, bounces: 1 }, roles)).not.toBeNull()
    expect(rung({ ...base, bounces: 2 }, roles)).toBeNull()
  })

  it('classifies hard items', () => {
    expect(isHard(base, roles)).toBe(false)
    expect(isHard({ ...base, area: 'native' }, roles)).toBe(true)
    expect(isHard({ ...base, allowedFiles: ['apps/desktop/src/main/ipc.ts'] }, roles)).toBe(true)
    expect(isHard({ ...base, allowedFiles: ['apps/desktop/src/main/**'] }, roles)).toBe(true)
    expect(isHard({ ...base, repeat: true }, roles)).toBe(true)
    expect(isHard({ ...base, bounces: 1 }, roles)).toBe(true)
  })

  it('returns the latest attempt', () => {
    expect(currentAttempt(base)).toBeNull()
    expect(currentAttempt({ ...base, attempts: [{ n: 1 }, { n: 2 }] })).toEqual({ n: 2 })
  })
})

describe('ledger files', () => {
  it('creates an empty ledger when missing and saves atomically', () => {
    const root = tempRoot()
    const ledger = loadLedger(root)
    expect(ledger.items).toEqual([])
    expect(typeof ledger.batch).toBe('string')
    ledger.items.push({ id: 'x' })
    saveLedger(root, ledger)
    expect(loadLedger(root)).toEqual(ledger)
    expect(readdirSync(join(root, 'orchestration')).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('appends decision and followup rows with a header and no stray tabs', () => {
    const root = tempRoot()
    decide(root, { item: 'x', phase: 'verify', decision: 'bounce', why: 'a\tb\nc', evidence: 'e', result: 'r' })
    decide(root, { item: 'x', phase: 'merge', decision: 'merge', why: 'w', evidence: '', result: 'ok' })
    followup(root, { item: 'x', file: 'a.ts', line: 3, claim: 'odd' })
    const decisions = readFileSync(join(root, 'orchestration/decisions.tsv'), 'utf8').trim().split('\n')
    expect(decisions[0]).toBe('ts\titem\tphase\tdecision\twhy\tevidence\tresult')
    expect(decisions).toHaveLength(3)
    expect(decisions[1].split('\t').slice(1)).toEqual(['x', 'verify', 'bounce', 'a b c', 'e', 'r'])
    const followups = readFileSync(join(root, 'orchestration/followups.tsv'), 'utf8').trim().split('\n')
    expect(followups[1].split('\t').slice(1)).toEqual(['x', 'a.ts', '3', 'odd'])
  })
})
