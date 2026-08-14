import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/engine/claude.js'
import { MockEngine } from '../src/engine/mock.js'
import { collectResult, extractJson, QuotaError, type Engine, type EngineCwd, type EngineEvent } from '../src/engine/types.js'
import { tmpVaultRoot } from './helpers.js'

const CWD = '.' as EngineCwd

function scriptedEngine(events: EngineEvent[]): Engine {
  return {
    id: 'mock',
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run() {
      yield* events
    },
  }
}

describe('engine event collection', () => {
  it('MockEngine streams tokens then a result keyed by JOB marker', async () => {
    const engine = new MockEngine({ J1: '{"ok":true}' })
    const events: EngineEvent[] = []
    for await (const e of engine.run({ prompt: 'JOB: J1\n...', workdir: CWD })) events.push(e)
    expect(events.filter((e) => e.type === 'token').length).toBeGreaterThanOrEqual(2)
    expect(events.at(-1)).toEqual({ type: 'result', text: '{"ok":true}' })
  })

  it('MockEngine errors on an unknown job kind', async () => {
    const engine = new MockEngine({ J1: 'x' })
    await expect(collectResult(engine, { prompt: 'JOB: J9\n', workdir: CWD })).rejects.toThrow(/canned/)
  })

  it('collectResult prefers the result event over accumulated tokens', async () => {
    const engine = scriptedEngine([
      { type: 'token', text: 'partial' },
      { type: 'result', text: 'final' },
    ])
    expect(await collectResult(engine, { prompt: '', workdir: CWD })).toBe('final')
  })

  it('collectResult falls back to tokens when no result arrives', async () => {
    const engine = scriptedEngine([
      { type: 'token', text: 'a' },
      { type: 'token', text: 'b' },
    ])
    expect(await collectResult(engine, { prompt: '', workdir: CWD })).toBe('ab')
  })

  it('quota-flavoured errors become QuotaError', async () => {
    const engine = scriptedEngine([{ type: 'error', message: 'HTTP 429 too many requests' }])
    await expect(collectResult(engine, { prompt: '', workdir: CWD })).rejects.toThrow(QuotaError)
  })

  it('extractJson digs JSON out of fenced prose', () => {
    const text = '설명입니다.\n```json\n{"cards": [{"a": "b}"}]}\n```\n끝.'
    expect(extractJson(text)).toEqual({ cards: [{ a: 'b}' }] })
  })

  it('extractJson handles arrays and rejects JSON-free text', () => {
    expect(extractJson('결과: [1, 2, 3] 입니다')).toEqual([1, 2, 3])
    expect(() => extractJson('JSON 없음')).toThrow()
  })
})

describe('claude adapter stream close', () => {
  it('returns as soon as the result line arrives, even when the CLI lingers', async () => {
    const dir = await tmpVaultRoot('linger-cli')
    const script = join(dir, 'fake.js')
    await writeFile(
      script,
      `console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));\n` +
        `setTimeout(() => {}, 30000); // linger long past the assertion window\n`,
    )
    const isWin = process.platform === 'win32'
    const bin = join(dir, isWin ? 'fake.cmd' : 'fake.sh')
    await writeFile(bin, isWin ? `@echo off\r\nnode "${script}" %*\r\n` : `#!/bin/sh\nexec node "${script}" "$@"\n`)
    if (!isWin) await chmod(bin, 0o755)

    const adapter = new ClaudeAdapter(60_000, bin)
    const started = Date.now()
    const events: EngineEvent[] = []
    for await (const e of adapter.run({ prompt: '질문', workdir: CWD })) events.push(e)
    expect(events).toContainEqual({ type: 'result', text: 'done' })
    expect(Date.now() - started).toBeLessThan(15_000) // not the 30s linger
  }, 30_000)
})
