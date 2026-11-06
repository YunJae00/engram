import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NODE_BIN, claudeLocalArgs, codexArgs, withNodeOnPath } from './launch-local.mjs'

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
