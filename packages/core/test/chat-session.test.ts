import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ClaudeChatSession } from '../src/engine/chat-session.js'
import type { EngineEvent } from '../src/engine/types.js'

// The warm chat lane: one process, many turns. These tests drive the real
// class against a scripted fake CLI (node script speaking stream-json), the
// same trick engine.test.ts uses — the protocol is the contract, not claude.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engram-chat-session-'))
})

// A fake claude: reads stdin lines; per user line answers with two partial
// deltas then a result. Stays alive between turns (that IS the feature).
const ECHO_CLI = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
let n = 0
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type !== 'user') return
  n += 1
  const text = msg.message.content[0].text
  process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'turn' + n + ':' } } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(0, 5) } } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'DUPLICATE — must not double-emit' }] } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'turn' + n + ':' + text.slice(0, 5) }) + '\\n')
})
`

async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

function sessionFor(script: string, turnTimeoutMs = 15_000): Promise<ClaudeChatSession> {
  const file = join(dir, 'fake-cli.cjs')
  return writeFile(file, script).then(() => {
    const session = new ClaudeChatSession(process.execPath, [file], { workdir: dir, turnTimeoutMs })
    session.start()
    return session
  })
}

describe('ClaudeChatSession', () => {
  it('answers two turns from ONE process, tokens once, result authoritative', async () => {
    const session = await sessionFor(ECHO_CLI)
    try {
      const first = await collect(session.send('hello world'))
      expect(first.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text)).toEqual(['turn1:', 'hello'])
      expect(first.at(-1)).toEqual({ type: 'result', text: 'turn1:hello' })
      expect(session.turns).toBe(1)

      const second = await collect(session.send('again please'))
      expect(second.at(-1)).toEqual({ type: 'result', text: 'turn2:again' })
      expect(session.isAlive()).toBe(true)
    } finally {
      session.close()
    }
  })

  it('a turn that blows its budget dies as a timeout and kills the session', async () => {
    const session = await sessionFor('setInterval(() => {}, 1000)', 300)
    try {
      const events = await collect(session.send('anyone home?'))
      const error = events.find((e) => e.type === 'error')
      expect(error && 'kind' in error ? error.kind : null).toBe('timeout')
      expect(session.isAlive()).toBe(false)
    } finally {
      session.close()
    }
  })

  it('an error result carries the quota retry-after through', async () => {
    const QUOTA_CLI = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', () => {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'usage limit reached, retry after 120 seconds' }) + '\\n')
})
`
    const session = await sessionFor(QUOTA_CLI)
    try {
      const events = await collect(session.send('q'))
      const error = events.find((e) => e.type === 'error') as { kind?: string; retryAfterMs?: number } | undefined
      expect(error?.kind).toBe('quota')
      expect(error?.retryAfterMs).toBe(120_000)
    } finally {
      session.close()
    }
  })

  it('a crashed process surfaces as an error, and a dead session refuses politely', async () => {
    const session = await sessionFor('process.exit(3)')
    const events = await collect(session.send('hello?'))
    expect(events.some((e) => e.type === 'error')).toBe(true)
    const refused = await collect(session.send('still there?'))
    expect(refused[0]?.type).toBe('error')
  })

  it('abort ends the turn silently — no error event, session dead', async () => {
    const session = await sessionFor('setInterval(() => {}, 1000)', 15_000)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const events = await collect(session.send('take your time', controller.signal))
    expect(events).toEqual([])
    expect(session.isAlive()).toBe(false)
  })
})
