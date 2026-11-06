import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { alive, Semaphore } from './procs.mjs'
import { parseClaudeTokens, parseCodexTokens } from './launch-local.mjs'
import { parseCloudOutput } from './launch-cloud.mjs'

const root = resolve(import.meta.dirname, '../../tmp/orch-test', `procs-${process.pid}`)
const slotsPath = join(root, 'orchestration/logs/slots.json')

function deadPid() {
  return spawnSync('true').pid
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('procs', () => {
  it('alive tells live from dead pids', () => {
    expect(alive(process.pid)).toBe(true)
    expect(alive(deadPid())).toBe(false)
  })

  it('semaphore fills, refuses, frees and persists', () => {
    const s = new Semaphore(2, root)
    expect(s.acquire('a', process.pid)).toBe(true)
    expect(s.acquire('b', process.ppid)).toBe(true)
    expect(s.acquire('c', process.pid)).toBe(false)
    expect(new Semaphore(2, root).slots.map((x) => x.label)).toEqual(['a', 'b'])
    s.release(process.ppid)
    expect(s.acquire('c', process.ppid)).toBe(true)
    expect(JSON.parse(readFileSync(slotsPath, 'utf8')).max).toBe(2)
  })

  it('drops dead pids on load', () => {
    mkdirSync(join(root, 'orchestration/logs'), { recursive: true })
    writeFileSync(slotsPath, JSON.stringify({ max: 1, slots: [{ pid: deadPid(), label: 'gone', since: 'x' }] }))
    const s = new Semaphore(1, root)
    expect(s.slots).toEqual([])
    expect(s.acquire('new', process.pid)).toBe(true)
  })
})

describe('output parsing', () => {
  it('sums claude usage tokens including cache tokens', () => {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5, server_tool_use: { web_search_requests: 0 } }
    expect(parseClaudeTokens(JSON.stringify({ result: 'ok', usage }))).toBe(1115)
    expect(parseClaudeTokens(JSON.stringify({ result: 'ok', usage: { input_tokens: 10, output_tokens: 5 } }))).toBe(15)
    expect(parseClaudeTokens('{"result":"ok"}')).toBeNull()
    expect(parseClaudeTokens('not json')).toBeNull()
  })

  it('sums input and output tokens of the last codex turn.completed line', () => {
    const lines = [
      'Reading additional input from stdin...',
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":1}}',
      'garbage "turn.completed" line',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
      '{"type":"turn.completed","usage":{"input_tokens":15302,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":6,"reasoning_output_tokens":0}}',
    ].join('\n')
    expect(parseCodexTokens(lines)).toBe(15308)
    expect(parseCodexTokens('{"type":"turn.started"}')).toBeNull()
  })

  it('parses the real codex spike log', () => {
    const sample = resolve(import.meta.dirname, '../../tmp/orch-spike/codex-json.log')
    if (existsSync(sample)) expect(parseCodexTokens(readFileSync(sample, 'utf8'))).toBe(15308)
  })

  it('finds the cloud session id and url', () => {
    expect(parseCloudOutput('\x1b[32mStarted session_01AbC9 at https://claude.ai/code/session_01AbC9\x1b[0m\r\n'))
      .toEqual({ sessionId: 'session_01AbC9', url: 'https://claude.ai/code/session_01AbC9' })
    expect(parseCloudOutput('error: not logged in')).toEqual({ sessionId: null, url: null })
  })
})
