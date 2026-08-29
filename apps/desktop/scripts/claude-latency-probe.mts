// Where a cloud turn's seconds go: the runtime's own start, one answer with
// no tools, and one answer that makes a tool call first.
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
const model = process.env['PROBE_MODEL'] ?? 'sonnet'

async function timed(label: string, options: Record<string, unknown>, prompt: string): Promise<void> {
  const started = Date.now()
  let first = 0
  let answer = ''
  for await (const message of query({ prompt, options: { cwd: process.cwd(), persistSession: false, settingSources: [], tools: [], model, ...options } })) {
    if (!first) first = Date.now() - started
    if (message.type === 'result' && 'result' in message) answer = String(message.result ?? '')
  }
  console.log(`${label}: first message ${first}ms, done ${Date.now() - started}ms, answer ${answer.replace(/\s+/g, ' ').slice(0, 80)}`)
}

await timed('plain', { maxTurns: 1 }, 'Reply with the single word: ready')
const server = createSdkMcpServer({
  name: 'probe',
  tools: [
    tool('lookup', 'look a word up', { word: z.string() }, async ({ word }) => ({ content: [{ type: 'text', text: `${word}: a small thing` }] })),
  ],
})
await timed('one tool', { maxTurns: 4, mcpServers: { probe: server }, allowedTools: ['mcp__probe__lookup'], permissionMode: 'dontAsk' }, 'Use the lookup tool on the word "pebble" and reply with what it says, nothing else.')
await timed('plain again', { maxTurns: 1 }, 'Reply with the single word: ready')
