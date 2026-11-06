import { describe, expect, it } from 'vitest'
import { cloudClaudeArgs, parseCloudOutput } from './launch-cloud.mjs'

describe('cloudClaudeArgs', () => {
  it('passes --model before --cloud when a model is set', () => {
    expect(cloudClaudeArgs('do the thing', { model: 'claude-opus-5-5' })).toEqual([
      'claude', '--model', 'claude-opus-5-5', '--cloud', 'do the thing',
    ])
  })

  it('omits --model when unset so the agent default applies', () => {
    expect(cloudClaudeArgs('do the thing')).toEqual(['claude', '--cloud', 'do the thing'])
  })
})

describe('parseCloudOutput', () => {
  it('extracts session id and url', () => {
    expect(parseCloudOutput('session_abc123 see https://claude.ai/code/xyz')).toEqual({
      sessionId: 'session_abc123',
      url: 'https://claude.ai/code/xyz',
    })
  })
})
