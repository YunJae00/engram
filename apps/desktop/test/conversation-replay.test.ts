import { expect, it, vi } from 'vitest'
import type { ToolSessionJob } from 'core'
import { conversation } from '../../../packages/core/src/agent-history.js'
import { checkpointResume } from '../src/main/comet-checkpoint.js'
vi.mock('electron', () => ({ app: { getPath: () => 'tmp/replay' } }))
import { SessionPool, type SessionSdk } from '../src/main/engine-claude-session.js'
import { closeCodexSessions, runCodexNative, type CodexRpcFactory } from '../src/main/codex-native.js'

it.each(['claude', 'codex'])('replays corrections once after images and a %s session restart', async engine => {
  const delivered: string[] = []
  const pool = new SessionPool()
  const sdk: SessionSdk = {
    createSdkMcpServer: options => options,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    query: ({ prompt }) => (async function* () {
      for await (const message of prompt) {
        delivered.push(JSON.stringify(message.message.content))
        yield { type: 'result', subtype: 'success', result: 'Recorded' }
      }
    })(),
  }
  const rpc: CodexRpcFactory = (_options, notify) => ({
    initialize: async () => {}, shutdown: async () => {},
    send: async (method, params) => {
      if (method === 'thread/start') return { thread: { id: 'replay-thread' } }
      if (method === 'turn/start') {
        delivered.push(JSON.stringify(params['input']))
        setTimeout(() => notify('turn/completed', { threadId: 'replay-thread', turn: { status: 'completed' } }), 0)
        return { turn: { id: 'replay-turn' } }
      }
      return {}
    },
  })
  const history: { role: 'user'; text: string; at: string; attachments?: string[] }[] = []
  const stored = { pending: ['Not Codex, Claude Desktop'] }
  const run = async (prompt: string, image = false) => {
    const job: ToolSessionJob = {
      workdir: 'tmp/replay' as ToolSessionJob['workdir'], system: 'Rules', sessionKey: 'replay', prompt,
      opening: [...conversation(history), checkpointResume(stored, history)].join('\n'), maxCalls: 3,
      tools: image ? [{ name: 'read_image', description: 'Read attached image', argsSchema: { type: 'object' }, run: async () => 'Image' }] : [],
    }
    if (engine === 'claude') await pool.run(job, { sdk, binary: 'fixture', workdir: 'tmp/replay' })
    else await runCodexNative({ ...job, native: { cwd: 'tmp/replay', mode: 'auto', decide: async () => ({ behavior: 'allow' }) } }, { rpc, env: {}, config: [], instructions: 'Rules' })
    history.push({ role: 'user', text: prompt, at: '2026-11-02T10:29:00Z', ...(image ? { attachments: ['image-1'] } : {}) })
  }
  try {
    await run('Read Codex')
    await run('Not Codex, Claude Desktop')
    await run('Attached: screenshot.png', true)
    pool.closeAll(); closeCodexSessions()
    await run('Continue the requested app read', true)
    const opening = delivered.at(-1)!
    expect(opening.match(/Not Codex, Claude Desktop/g)).toHaveLength(1)
    expect(opening).toContain('Claude Desktop')
    expect(opening).toContain('Attached: screenshot.png')
    expect(opening).toContain('2026-11-02 10:29Z')
  } finally { pool.closeAll(); closeCodexSessions() }
})
