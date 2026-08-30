import { describe, expect, it } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runComet, runToolSession } from '../src/agent-session.js'
import { formatAsk } from '../src/ask.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'

const WORKDIR = 'C:/tmp' as EngineCwd

// A brain that holds its own loop: it calls the tools it is handed in the
// order a script says, then answers.
function sessionBrain(script: (job: ToolSessionJob) => Promise<ToolSessionResult>): Engine {
  return {
    id: 'mock',
    detect: async () => ({ installed: true, loggedIn: true }),
    run: async function* () {
      yield { type: 'result', text: 'step loop answer' }
    },
    runTools: script,
  } as unknown as Engine
}

const tools: AgentTool[] = [
  { name: 'search_memory', description: 'search', argsSchema: { type: 'object', properties: { query: { type: 'string' } } }, run: async (args) => `notes about ${String(args['query'])}` },
  { name: 'ask_person', description: 'ask', argsSchema: { type: 'object', properties: { question: { type: 'string' } } }, run: async (args) => formatAsk(String(args['question']), ['A', 'B']) },
]

describe('a tool session: the brain loops, the turn keeps the loop\'s shape', () => {
  it('hands the tools over with the persona in the system prompt and records every call as a step', async () => {
    const seen: { system: string; prompt: string; opening?: string; key?: string }[] = []
    const engine = sessionBrain(async (job) => {
      seen.push({ system: job.system, prompt: job.prompt, ...(job.opening ? { opening: job.opening } : {}), ...(job.sessionKey ? { key: job.sessionKey } : {}) })
      const search = job.tools.find((t) => t.name === 'search_memory')!
      const got = await search.run({ query: 'deploys' })
      return { answer: `From the notes: ${got}` }
    })
    const lines: string[] = []
    const result = await runToolSession({ engine, workdir: WORKDIR, tools }, 'what did we decide about deploys?', {
      persona: 'You are "Scout".',
      guided: false,
      session: 'bot-1',
      history: [{ role: 'user', text: 'earlier' }],
      onStep: (line) => lines.push(line),
    })
    // The rules stand in the system prompt; who speaks and what they want
    // travel with the turn; the conversation opens the session; the key
    // lets the brain keep it.
    expect(seen[0]!.system).toContain('language of their message')
    expect(seen[0]!.system).not.toContain('Scout')
    expect(seen[0]!.prompt).toContain('You are "Scout".')
    expect(seen[0]!.prompt).toContain('Task: what did we decide about deploys?')
    expect(seen[0]!.opening).toContain('User: earlier')
    expect(seen[0]!.key).toBe('bot-1')
    expect(result.steps.map((s) => s.tool)).toEqual(['search_memory'])
    expect(result.answer).toBe('From the notes: notes about deploys')
    expect(lines).toEqual(['search_memory: deploys'])
    expect(result.asked).toBeUndefined()
  })

  it('a question to the person ends the turn as an ask, whatever the brain says afterwards', async () => {
    const engine = sessionBrain(async (job) => {
      const ask = job.tools.find((t) => t.name === 'ask_person')!
      const told = await ask.run({ question: 'Which site?' })
      expect(told).toContain('with the person')
      return { answer: 'Let me know which site.' }
    })
    const result = await runToolSession({ engine, workdir: WORKDIR, tools }, 'upload the report', { guided: false })
    expect(result.asked).toBe(true)
    expect(result.answer).toBe('Which site?')
    expect(result.options).toEqual(['A', 'B'])
  })

  it('a brain without a session, or a guided turn, goes through the step loop', async () => {
    const stepOnly = sessionBrain(async () => ({ answer: 'session answer' }))
    delete (stepOnly as { runTools?: unknown }).runTools
    const viaLoop = await runComet({ engine: stepOnly, workdir: WORKDIR, tools }, 'hello', { guided: false })
    expect(viaLoop.answer).toContain('step loop answer')
    const guided = await runComet({ engine: sessionBrain(async () => ({ answer: 'session answer' })), workdir: WORKDIR, tools }, 'hello', { guided: true })
    expect(guided.answer).toContain('step loop answer')
    const session = await runComet({ engine: sessionBrain(async () => ({ answer: 'session answer' })), workdir: WORKDIR, tools }, 'hello', { guided: false })
    expect(session.answer).toBe('session answer')
  })

  it('a session that failed is an error, not an empty answer', async () => {
    const engine = sessionBrain(async () => ({ answer: '', error: 'timed out after 1ms' }))
    await expect(runToolSession({ engine, workdir: WORKDIR, tools }, 'hello', { guided: false })).rejects.toThrow(/timed out/)
  })
})

describe('what the person said earlier is a source for a blank', () => {
  it('a "yes, go ahead" turn keeps the room and time from the message before it', async () => {
    const seen: { task: string; read?: string }[] = []
    const engine = sessionBrain(async (job) => {
      const tool = job.tools.find((t) => t.name === 'search_memory')!
      await tool.run({ query: 'x' })
      return { answer: 'done' }
    })
    const spy: AgentTool = {
      name: 'search_memory',
      description: 'search',
      argsSchema: {},
      run: async (_args, context) => {
        seen.push({ task: context.task, ...(context.read !== undefined ? { read: context.read } : {}) })
        return 'nothing'
      },
    }
    await runToolSession({ engine, workdir: WORKDIR, tools: [spy] }, '네, 진행해주세요', {
      guided: false,
      history: [
        { role: 'user', text: '회의실 B 모레 오전 11시 예약해줘' },
        { role: 'assistant', text: '오늘 이미 실행했는데 다시 할까요?' },
      ],
    })
    expect(seen[0]!.read).toContain('회의실 B 모레 오전 11시')
  })
})

describe('looking comes before asking', () => {
  it('the first question of a turn, before any search, is sent to the search; asked again after looking, it goes through', async () => {
    const heard: string[] = []
    const engine = sessionBrain(async (job) => {
      const ask = job.tools.find((t) => t.name === 'ask_person')!
      const search = job.tools.find((t) => t.name === 'search_web')!
      heard.push(String(await ask.run({ question: 'Which report?' })))
      heard.push(String(await search.run({ query: 'the report' })))
      heard.push(String(await ask.run({ question: 'Which report?' })))
      return { answer: 'ignored' }
    })
    const withSearch: AgentTool[] = [...tools, { name: 'search_web', description: 'search', argsSchema: {}, run: async () => 'nothing came back' }]
    const result = await runToolSession({ engine, workdir: WORKDIR, tools: withSearch }, 'summarise the report', { guided: false })
    expect(heard[0]).toContain('Look before you ask')
    expect(heard[0]).toContain('search_web')
    expect(heard[1]).toBe('nothing came back')
    expect(result.asked).toBe(true)
    expect(result.answer).toBe('Which report?')
  })
})
