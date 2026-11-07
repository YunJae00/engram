import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NODE_BIN, claudeLocalArgs, codexArgs, codexOutputSchema, materializeCodexSchema, withNodeOnPath } from './launch-local.mjs'

describe('withNodeOnPath', () => {
  it('prefixes Node with the platform delimiter and keeps a Windows Path key', () => {
    const input = { Path: 'C:\\Windows', OTHER: '1' }
    const env = withNodeOnPath(input)
    expect(env.Path).toBe(`${NODE_BIN}${delimiter}C:\\Windows`)
    expect(env.PATH).toBeUndefined()
    expect(env.OTHER).toBe('1')
    expect(input.Path).toBe('C:\\Windows')
  })

  it('sets PATH when the environment has none', () => {
    expect(withNodeOnPath({}).PATH).toBe(NODE_BIN)
  })
})

describe('claudeLocalArgs', () => {
  it('inserts --model when provided', () => {
    expect(claudeLocalArgs({ prompt: 'p', model: 'claude-sonnet-5-5' })).toEqual([
      '-p', 'p', '--dangerously-skip-permissions', '--output-format', 'json', '--model', 'claude-sonnet-5-5',
    ])
  })
})

describe('codexOutputSchema', () => {
  it('inlines $ref and drops draft-07 keywords Codex structured output rejects', () => {
    const flat = codexOutputSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'verdict',
      type: 'object',
      definitions: {
        entry: { type: 'object', required: ['x'], properties: { x: { type: 'string', pattern: '^[a-z]+$', minimum: 1 } } },
      },
      properties: { list: { type: 'array', items: { $ref: '#/definitions/entry' } } },
    })
    expect(flat.$schema).toBeUndefined()
    expect(flat.definitions).toBeUndefined()
    expect(flat.properties.list.items.properties.x).toEqual({ type: 'string' })
    expect(JSON.stringify(flat)).not.toContain('$ref')
    expect(JSON.stringify(flat)).not.toContain('pattern')
  })

  it('writes a flattened verdict schema for Codex', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-schema-'))
    const dest = join(dir, 'out.schema.json')
    try {
      materializeCodexSchema(fileURLToPath(new URL('../schemas/verdict.schema.json', import.meta.url)), dest)
      const flat = JSON.parse(readFileSync(dest, 'utf8'))
      expect(flat.properties.evidence.items.required).toEqual(['criterion', 'cmd', 'logPath', 'result'])
      expect(flat.properties.findings.items.properties.reproCmd.type).toBe('string')
      expect(JSON.stringify(flat)).not.toMatch(/\$ref|pattern/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('codexArgs', () => {
  it('passes -m before output flags when a model is set', () => {
    expect(codexArgs({
      cwd: '/tmp/w', prompt: 'p', sandbox: 'workspace-write', outPath: '/tmp/out', model: 'gpt-6-sol',
    })).toEqual([
      'exec', '-C', '/tmp/w', '-s', 'workspace-write', '-c', 'allow_login_shell=false',
      '--skip-git-repo-check', '--ephemeral', '-m', 'gpt-6-sol', '-o', '/tmp/out', '--json', 'p',
    ])
  })
})
