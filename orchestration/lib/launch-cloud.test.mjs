import process from 'node:process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { cloudClaudeArgs, parseCloudOutput, scriptArgs } from './launch-cloud.mjs'

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

describe('scriptArgs', () => {
  const command = ['claude', '--model', 'claude-opus-5-5', '--cloud', "it's a $prompt\nwith a quote"]

  it('keeps the macOS form: quiet, log file, then the command argv', () => {
    expect(scriptArgs('/tmp/cloud.log', command, { platform: 'darwin' })).toEqual([
      '-q', '/tmp/cloud.log', ...command,
    ])
  })

  it('uses util-linux -e -c and quotes the command as one argument', () => {
    const args = scriptArgs('/tmp/cloud.log', command, { platform: 'linux' })
    expect(args.slice(0, 3)).toEqual(['-q', '-e', '-c'])
    expect(args[3]).toBe(`'claude' '--model' 'claude-opus-5-5' '--cloud' 'it'\\''s a $prompt\nwith a quote'`)
    expect(args[4]).toBe('/tmp/cloud.log')
    expect(args).toHaveLength(5)
  })

  it.skipIf(process.platform === 'win32')('runs echo under the host script, including a quote in the argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'script-probe-'))
    const log = join(dir, 'typescript')
    try {
      const result = spawnSync('script', scriptArgs(log, ['echo', "probe-ok it's fine\nline2"]), { encoding: 'utf8' })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      const text = `${result.stdout}\n${readFileSync(log, 'utf8')}`
      expect(text).toContain("probe-ok it's fine")
      expect(text).toContain('line2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
