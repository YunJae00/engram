import { describe, expect, it } from 'vitest'
import { URL, fileURLToPath } from 'node:url'
import { loadRoles } from './ledger.mjs'
import { resolveAgentModel } from './runtime.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const roles = loadRoles(repoRoot)

describe('resolveAgentModel', () => {
  it('uses Opus for Claude implement, verify and design from roles.md', () => {
    expect(resolveAgentModel(roles, { agent: 'claude-cloud', role: 'implement' })).toBe('claude-opus-5-5')
    expect(resolveAgentModel(roles, { agent: 'claude-cloud', role: 'verify' })).toBe('claude-opus-5-5')
    expect(resolveAgentModel(roles, { agent: 'claude-local', role: 'design' })).toBe('claude-opus-5-5')
  })

  it('uses the Codex workhorse slug for every Codex phase', () => {
    expect(resolveAgentModel(roles, { agent: 'codex-local', role: 'implement' })).toBe('gpt-6-sol')
    expect(resolveAgentModel(roles, { agent: 'codex-local', role: 'verify' })).toBe('gpt-6-sol')
  })

  it('returns undefined when models are absent', () => {
    expect(resolveAgentModel({}, { agent: 'claude-cloud', role: 'implement' })).toBeUndefined()
  })
})
