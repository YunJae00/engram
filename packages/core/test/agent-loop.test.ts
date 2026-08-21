import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { detectLoop, runAgentLoop, type AgentTool } from '../src/agent-loop.js'
import { cometTools } from '../src/comet-tools.js'
import { listCards } from '../src/cards.js'
import { addRoutine } from '../src/routine.js'
import { MockEngine } from '../src/engine/mock.js'
import { engineCwd } from '../src/engine/types.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

function tool(name: string, run?: AgentTool['run']): AgentTool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = []
  return {
    name,
    description: `${name} does its thing`,
    argsSchema: { type: 'object' },
    calls,
    run:
      run ??
      (async (args) => {
        calls.push(args)
        return `observation from ${name}`
      }),
  }
}

async function deps(prefix: string, tools: AgentTool[], engine: MockEngine) {
  const paths = await initVault(await tmpVaultRoot(prefix), { git: false })
  return { paths, deps: { engine, workdir: engineCwd(paths), tools } }
}

describe('runAgentLoop — dispatch', () => {
  it('runs the chosen tool, feeds the observation back, and returns the answer', async () => {
    const search = tool('search_memory')
    const prompts: string[] = []
    let call = 0
    const engine = new MockEngine({
      'COMET-STEP': (prompt) => {
        prompts.push(prompt)
        call++
        return call === 1
          ? '{"tool": "search_memory", "args": {"query": "deploy decisions"}}'
          : '{"tool": "answer", "args": {"text": "We deploy on Fridays."}}'
      },
    })
    const { deps: d } = await deps('loop-dispatch', [search], engine)
    const lines: string[] = []
    const result = await runAgentLoop(d, 'what did we decide about deploys?', {
      persona: 'You are "Deploy keeper".',
      onStep: (line) => lines.push(line),
    })
    expect(result.answer).toBe('We deploy on Fridays.')
    expect(result.fellBack).toBe(false)
    expect(result.stopped).toBeUndefined()
    expect(search.calls).toEqual([{ query: 'deploy decisions' }])
    expect(result.steps).toEqual([
      { tool: 'search_memory', args: { query: 'deploy decisions' }, observation: 'observation from search_memory' },
    ])
    expect(lines).toEqual(['search_memory: deploy decisions'])
    // The second call saw what the first one found, and who it is.
    expect(prompts[1]).toContain('observation from search_memory')
    expect(prompts[1]).toContain('Deploy keeper')
  })

  it('shows the model at most five tools — a longer menu costs accuracy', async () => {
    const tools = Array.from({ length: 7 }, (_, i) => tool(`t${i}`))
    let seen = ''
    const engine = new MockEngine({
      'COMET-STEP': (prompt) => {
        seen = prompt
        return '{"tool": "answer", "args": {"text": "ok"}}'
      },
    })
    const { deps: d } = await deps('loop-menu', tools, engine)
    await runAgentLoop(d, 'anything')
    expect(seen).toContain('- t4:')
    expect(seen).not.toContain('- t5:')
    expect(seen).not.toContain('- t6:')
  })

  it('a failing tool becomes an observation, never a crash', async () => {
    const broken = tool('broken', async () => {
      throw new Error('the page took too long')
    })
    let call = 0
    const engine = new MockEngine({
      'COMET-STEP': () => {
        call++
        return call === 1
          ? '{"tool": "broken", "args": {}}'
          : '{"tool": "answer", "args": {"text": "could not reach it"}}'
      },
    })
    const { deps: d } = await deps('loop-toolfail', [broken], engine)
    const result = await runAgentLoop(d, 'try the thing')
    expect(result.answer).toBe('could not reach it')
    expect(result.steps[0]!.observation).toContain('the page took too long')
  })
})

describe('runAgentLoop — guards (a 2B model WILL wander)', () => {
  it('two broken outputs in a row fall back to a plain answer — no dead ends', async () => {
    const engine = new MockEngine({
      'COMET-STEP': 'I think the best course of action would be to search.',
      'COMET-ANSWER': 'Here is a plain answer instead.',
    })
    const { deps: d } = await deps('loop-fallback', [tool('search_memory')], engine)
    const result = await runAgentLoop(d, 'anything')
    expect(result.fellBack).toBe(true)
    expect(result.answer).toBe('Here is a plain answer instead.')
    expect(result.steps).toEqual([])
  })

  it('the same call twice in a row stops the loop and wraps up with what it has', async () => {
    const search = tool('search_memory')
    const engine = new MockEngine({
      'COMET-STEP': '{"tool": "search_memory", "args": {"query": "same thing"}}',
      'COMET-ANSWER': 'wrapped up',
    })
    const { deps: d } = await deps('loop-repeat', [search], engine)
    const result = await runAgentLoop(d, 'anything')
    expect(result.stopped).toBe('repetition')
    expect(result.answer).toBe('wrapped up')
    // the hammering was caught before the second identical run
    expect(search.calls).toHaveLength(1)
  })

  it('bouncing A→B→A→B stops the loop as oscillation', async () => {
    const a = tool('a')
    const b = tool('b')
    let call = 0
    const engine = new MockEngine({
      'COMET-STEP': () => {
        call++
        return call % 2 === 1 ? '{"tool": "a", "args": {"x": 1}}' : '{"tool": "b", "args": {"x": 2}}'
      },
      'COMET-ANSWER': 'settled',
    })
    const { deps: d } = await deps('loop-osc', [a, b], engine)
    const result = await runAgentLoop(d, 'anything')
    expect(result.stopped).toBe('oscillation')
    expect(result.answer).toBe('settled')
  })

  it('the call budget is a hard ceiling, and reaching it still answers', async () => {
    const search = tool('search_memory')
    let call = 0
    const engine = new MockEngine({
      'COMET-STEP': () => {
        call++
        return `{"tool": "search_memory", "args": {"query": "angle ${call}"}}`
      },
      'COMET-ANSWER': 'out of budget, but here is what I found',
    })
    const { deps: d } = await deps('loop-cap', [search], engine)
    const result = await runAgentLoop(d, 'anything', { maxCalls: 3 })
    expect(result.stopped).toBe('calls')
    expect(search.calls).toHaveLength(3)
    expect(result.answer).toBe('out of budget, but here is what I found')
  })
})

describe('detectLoop', () => {
  it('names the two stuck shapes and nothing else', () => {
    expect(detectLoop(['a'])).toBeNull()
    expect(detectLoop(['a', 'a'])).toBe('repetition')
    expect(detectLoop(['a', 'b', 'a', 'b'])).toBe('oscillation')
    expect(detectLoop(['a', 'b', 'c', 'd'])).toBeNull()
    expect(detectLoop(['a', 'b', 'a', 'c'])).toBeNull()
  })
})

describe('cometTools — every write ends in a card', () => {
  it('propose_note files a review card and writes NOTHING into notes/', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-propose'), { git: false })
    const tools = cometTools({ paths, retrieve: async () => [] })
    const propose = tools.find((t) => t.name === 'propose_note')!
    const before = await readdir(paths.notes)
    const observation = await propose.run({ title: 'Weekly report path', body: 'Portal → Reports → Weekly.' })
    expect(observation).toContain('waiting for the person')
    expect(await readdir(paths.notes)).toEqual(before)
    const cards = await listCards(paths)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.proposed).toContain('Weekly report path')
  })

  it('find_procedure matches a saved routine by name, and suggests teaching when nothing matches', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-find'), { git: false })
    await addRoutine(paths, {
      name: 'Weekly report upload',
      steps: [{ kind: 'open', url: 'https://portal.example/reports' }, { kind: 'read' }],
    })
    const tools = cometTools({ paths, retrieve: async () => [] })
    const find = tools.find((t) => t.name === 'find_procedure')!
    expect(await find.run({ task: 'upload the weekly report' })).toContain('found "Weekly report upload"')
    expect(await find.run({ task: 'water the plants' })).toContain('suggest teaching it once')
  })

  it('search_memory answers with titled excerpts and honest emptiness', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-search'), { git: false })
    const tools = cometTools({
      paths,
      retrieve: async (query) =>
        query === 'deploys'
          ? [{ id: 'n-1', title: 'Deploy decision', body: 'Fridays only.', created: '2026-08-01T00:00:00Z' }]
          : [],
    })
    const search = tools.find((t) => t.name === 'search_memory')!
    expect(await search.run({ query: 'deploys' })).toContain('[Deploy decision] (id: n-1) Fridays only.')
    expect(await search.run({ query: 'nothing' })).toContain('nothing in the vault')
  })
})
