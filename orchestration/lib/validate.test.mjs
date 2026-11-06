import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { validate } from './validate.mjs'

const schemaDir = new URL('../schemas/', import.meta.url)
const load = (name) => JSON.parse(readFileSync(new URL(name, schemaDir), 'utf8'))

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind'],
  properties: {
    id: { type: 'string', pattern: '^[a-z]+$' },
    kind: { type: 'string', enum: ['a', 'b'] },
    n: { type: 'integer', minimum: 1 },
    list: { type: 'array', minItems: 1, items: { $ref: '#/definitions/entry' } },
  },
  definitions: { entry: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } } },
}

describe('validate', () => {
  it('accepts a valid value', () => {
    expect(validate(schema, { id: 'abc', kind: 'a', n: 2, list: [{ x: 'y' }] })).toEqual([])
  })

  it('reports missing required properties', () => {
    expect(validate(schema, { id: 'abc' })).toEqual(['$: missing required property kind'])
  })

  it('reports enum and pattern violations', () => {
    const errors = validate(schema, { id: 'ABC', kind: 'z' })
    expect(errors).toEqual(['$.id: does not match ^[a-z]+$', '$.kind: must be one of a, b'])
  })

  it('rejects additional properties when closed', () => {
    expect(validate(schema, { id: 'a', kind: 'a', extra: 1 })).toEqual(['$: unexpected property extra'])
  })

  it('follows $ref to definitions and checks minItems', () => {
    expect(validate(schema, { id: 'a', kind: 'a', list: [{}] })).toEqual(['$.list[0]: missing required property x'])
    expect(validate(schema, { id: 'a', kind: 'a', list: [] })).toEqual(['$.list: must have at least 1 items'])
  })

  it('checks type, integer and minimum', () => {
    expect(validate(schema, { id: 'a', kind: 'a', n: 1.5 })).toEqual(['$.n: expected integer, got number'])
    expect(validate(schema, { id: 'a', kind: 'a', n: 0 })).toEqual(['$.n: must be >= 1'])
    expect(validate(schema, [])).toEqual(['$: expected object, got array'])
  })

  it('accepts type unions', () => {
    expect(validate({ type: ['integer', 'null'] }, null)).toEqual([])
    expect(validate({ type: ['integer', 'null'] }, 'x')).toHaveLength(1)
  })

  it('validates a brief against the shipped schema', () => {
    const brief = {
      id: 'fix-x',
      title: 'fix x',
      area: 'ts',
      difficulty: 'easy',
      goal: 'g',
      facts: [],
      criteria: [{ id: 'c1', cmd: 'true', expect: 'exit 0' }],
      allowedFiles: ['packages/core/src/x.ts'],
      outOfScope: [],
    }
    expect(validate(load('brief.schema.json'), brief)).toEqual([])
    expect(validate(load('brief.schema.json'), { ...brief, criteria: [] })).toHaveLength(1)
  })

  it('validates a ledger against the shipped schema', () => {
    const ledger = {
      batch: 'b1',
      items: [{
        id: 'fix-x', title: 'fix x', area: 'ts', difficulty: 'easy', state: 'queued', bounces: 0,
        allowedFiles: ['a'], criteria: [{ id: 'c', cmd: 'true', expect: '0' }], scenarios: [],
        attempts: [{ n: 1, implementer: 'claude-cloud', verifier: 'codex-local', branch: 'orch/fix-x-1',
          startedAt: '2026-01-01T00:00:00Z', deadlineAt: '2026-01-01T00:45:00Z', tokens: null }],
        verdicts: [],
      }],
    }
    expect(validate(load('ledger.schema.json'), ledger)).toEqual([])
  })
})
