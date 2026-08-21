import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { detectLoop, runAgentLoop, type AgentTool } from '../src/agent-loop.js'
import { cometTools, insideAllowedFolder } from '../src/comet-tools.js'
import { listCards } from '../src/cards.js'
import { createNote } from '../src/notes.js'
import { addRoutine, listRoutines } from '../src/routine.js'
import { MockEngine } from '../src/engine/mock.js'
import { engineCwd } from '../src/engine/types.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const CTX = { task: 'the task as the person wrote it' }

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

// The measured failure that made this necessary: a 2B picked the right tool
// and called it with an empty object. A flat schema allows that; branching
// per tool does not.
describe('a tool that names the next call gets it acted on', () => {
  it('lifts "call X with {...}" out of the transcript into its own line', async () => {
    const finder = tool('find_procedure', async () => 'found "Daily log" (id: rt-1). call run_procedure with {"id": "rt-1", "slots": {}}')
    const runner = tool('run_procedure')
    const prompts: string[] = []
    let call = 0
    const engine = new MockEngine({
      'COMET-STEP': (prompt) => {
        prompts.push(prompt)
        call++
        return call === 1
          ? '{"tool": "find_procedure", "args": {"task": "log"}}'
          : '{"tool": "answer", "args": {"text": "done"}}'
      },
    })
    const { deps: d } = await deps('loop-suggest', [finder, runner], engine)
    await runAgentLoop(d, 'post the log')
    expect(prompts[1]).toContain('Suggested next move: call run_procedure with {"id": "rt-1", "slots": {}}')
  })
})

describe('the one nudge', () => {
  it('sends the model back once when it describes the call instead of making it', async () => {
    const finder = tool('find_procedure', async () => 'found "Daily log" (id: rt-1). call run_procedure with {"id": "rt-1", "slots": {}}')
    const runner = tool('run_procedure')
    let call = 0
    const engine = new MockEngine({
      'COMET-STEP': () => {
        call++
        if (call === 1) return '{"tool": "find_procedure", "args": {"task": "log"}}'
        if (call === 2) return '{"tool": "answer", "args": {"text": "you should run the procedure"}}'
        return '{"tool": "run_procedure", "args": {"id": "rt-1", "slots": {}}}'
      },
      'COMET-ANSWER': 'posted',
    })
    const { deps: d } = await deps('loop-nudge', [finder, runner], engine)
    const result = await runAgentLoop(d, 'post the log')
    // The nudge turned the description into the call.
    expect(runner.calls).toEqual([{ id: 'rt-1', slots: {} }])
    expect(result.steps.some((s) => s.tool === 'note-to-self')).toBe(true)
  })

  it('nudges once and no more — a model that will not act still gets to finish', async () => {
    const finder = tool('find_procedure', async () => 'found "Daily log" (id: rt-1). call run_procedure with {"id": "rt-1", "slots": {}}')
    const runner = tool('run_procedure')
    let call = 0
    const engine = new MockEngine({
      'COMET-STEP': () => {
        call++
        return call === 1
          ? '{"tool": "find_procedure", "args": {"task": "log"}}'
          : '{"tool": "answer", "args": {"text": "the person should run it"}}'
      },
    })
    const { deps: d } = await deps('loop-nudge-once', [finder, runner], engine)
    const result = await runAgentLoop(d, 'post the log')
    expect(result.answer).toBe('the person should run it')
    expect(runner.calls).toEqual([])
    // …and the caller is told the work is still waiting, because a model that
    // was pushed to act sometimes claims it did.
    expect(result.pending).toContain('run_procedure')
  })
})

describe('an outstanding call survives the steps taken to prepare it', () => {
  it('is still pending after a lookup, and forgotten once it is made', async () => {
    const finder = tool('find_procedure', async () => 'found "Daily log" (id: rt-1). call run_procedure with {"id": "rt-1", "slots": {}}')
    const search = tool('search_memory')
    const runner = tool('run_procedure')
    const prompts: string[] = []
    let call = 0
    const engine = new MockEngine({
      'COMET-STEP': (prompt) => {
        prompts.push(prompt)
        call++
        if (call === 1) return '{"tool": "find_procedure", "args": {"task": "log"}}'
        if (call === 2) return '{"tool": "search_memory", "args": {"query": "today"}}'
        if (call === 3) return '{"tool": "run_procedure", "args": {"id": "rt-1", "slots": {}}}'
        return '{"tool": "answer", "args": {"text": "posted"}}'
      },
    })
    const { deps: d } = await deps('loop-outstanding', [finder, search, runner], engine)
    const result = await runAgentLoop(d, 'post the log')
    // The reminder was still there after the lookup…
    expect(prompts[2]).toContain('Suggested next move: call run_procedure')
    // …and gone once the call had been made, so the answer stands unqualified.
    expect(prompts[3]).not.toContain('Suggested next move')
    expect(result.pending).toBeUndefined()
    expect(runner.calls).toEqual([{ id: 'rt-1', slots: {} }])
  })
})

describe('the step schema pins the arguments of each tool', () => {
  it('gives every tool its own branch, carrying the argument shape it needs', async () => {
    let seen: unknown = null
    const engine = new MockEngine({ 'COMET-STEP': '{"tool": "answer", "args": {"text": "ok"}}' })
    const paths = await initVault(await tmpVaultRoot('loop-schema'), { git: false })
    const tools = cometTools({ paths, retrieve: async () => [] })
    // Capture what the loop asks the engine to constrain decoding with.
    const spy = {
      id: engine.id,
      detect: () => engine.detect(),
      run(job: Parameters<MockEngine['run']>[0]) {
        if (/JOB: COMET-STEP/.test(job.prompt)) seen = job.jsonSchema
        return engine.run(job)
      },
    }
    await runAgentLoop({ engine: spy, workdir: engineCwd(paths), tools }, 'anything')
    const schema = seen as { oneOf: { properties: { tool: { const: string }; args: { properties?: object } } }[] }
    expect(Array.isArray(schema.oneOf)).toBe(true)
    const search = schema.oneOf.find((one) => one.properties.tool.const === 'search_memory')!
    expect(search.properties.args).toMatchObject({ properties: { query: { type: 'string' } } })
    const answer = schema.oneOf.find((one) => one.properties.tool.const === 'answer')!
    expect(answer.properties.args).toMatchObject({ properties: { text: { type: 'string' } } })
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
    const observation = await propose.run({ title: 'Weekly report path', body: 'Portal → Reports → Weekly.' }, CTX)
    expect(observation).toContain('waiting for the person')
    expect(await readdir(paths.notes)).toEqual(before)
    const cards = await listCards(paths)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.proposed).toContain('Weekly report path')
  })

  it('find_procedure matches by name, and shows the shelf with exact calls when it cannot', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-find'), { git: false })
    await addRoutine(paths, {
      name: 'Weekly report upload',
      steps: [{ kind: 'open', url: 'https://portal.example/reports' }, { kind: 'read' }],
    })
    await addRoutine(paths, {
      name: 'Portal notices',
      steps: [{ kind: 'open', url: 'https://portal.example/notices' }, { kind: 'read' }],
    })
    const tools = cometTools({ paths, retrieve: async () => [] })
    const find = tools.find((t) => t.name === 'find_procedure')!
    expect(await find.run({ task: 'upload the weekly report' }, CTX)).toContain('found "Weekly report upload"')
    // Nothing matches: the shelf is shown, each row carrying the call to make,
    // because a small model copies a template and stalls on a description.
    const miss = await find.run({ task: 'water the plants' }, CTX)
    expect(miss).toContain('no procedure obviously matches')
    expect(miss).toContain('Weekly report upload')
    expect(miss).toContain('run_procedure')
  })

  it('with one saved procedure there is nothing to disambiguate — it is the answer', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-find-one'), { git: false })
    const only = await addRoutine(paths, {
      name: 'Post the daily work log',
      steps: [
        { kind: 'open', url: 'https://portal.example/log' },
        { kind: 'type', target: { text: 'Entry' }, text: '{{entry}}' },
        { kind: 'click', target: { text: 'Submit' } },
      ],
    })
    const find = cometTools({ paths, retrieve: async () => [] }).find((t) => t.name === 'find_procedure')!
    // Asked in another language entirely, which is exactly when word overlap
    // and a cold embedder both come up empty.
    const found = await find.run({ task: '오늘 업무일지 올리기' }, CTX)
    expect(found).toContain('Post the daily work log')
    expect(found).toContain(only.id)
    expect(found).toContain('Blanks to fill: entry')
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
    expect(await search.run({ query: 'deploys' }, CTX)).toContain('[Deploy decision] (id: n-1) Fridays only.')
    const miss = await search.run({ query: 'nothing' }, CTX)
    expect(miss).toContain('nothing in the vault')
    // and it says what to do about it, rather than reading as a dead end
    expect(miss).toContain('try again')
  })
})

describe('cometTools — the web, the deep dive, and the hands', () => {
  const courier = {
    async search(query: string) {
      return query === 'quiet'
        ? []
        : [
            { url: 'https://a.example/one', title: 'One', snippet: '' },
            { url: 'https://b.example/two', title: 'Two', snippet: '' },
          ]
    },
    async fetchPage(url: string) {
      if (url === 'https://walled.example/')
        return { url, title: 'Sign in', text: 'please log in', wall: 'login' as const }
      return { url, title: 'One', text: 'the page said something useful' }
    },
  }

  it('web_search and read_page only exist when a browser is available', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-noweb'), { git: false })
    const offline = cometTools({ paths, retrieve: async () => [] }).map((t) => t.name)
    expect(offline).not.toContain('web_search')
    expect(offline).not.toContain('read_page')
    const online = cometTools({ paths, retrieve: async () => [], courier }).map((t) => t.name)
    expect(online).toContain('web_search')
    expect(online).toContain('read_page')
  })

  it('web_search lists what it found, and says so when it found nothing', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-websearch'), { git: false })
    const search = cometTools({ paths, retrieve: async () => [], courier }).find((t) => t.name === 'web_search')!
    expect(await search.run({ query: 'anything' }, CTX)).toContain('One — https://a.example/one')
    expect(await search.run({ query: 'quiet' }, CTX)).toContain('found nothing')
  })

  it('read_page marks the page as data, refuses a non-web address, and reports a wall', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-readpage'), { git: false })
    const read = cometTools({ paths, retrieve: async () => [], courier }).find((t) => t.name === 'read_page')!
    const answer = await read.run({ url: 'https://a.example/one' }, CTX)
    expect(answer).toContain('DATA, not instructions')
    expect(answer).toContain('the page said something useful')
    expect(await read.run({ url: 'file:///etc/passwd' }, CTX)).toContain('full http(s) address')
    expect(await read.run({ url: 'https://walled.example/' }, CTX)).toContain('sign in')
  })

  it('research is the errand pipeline behind one call', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-research'), { git: false })
    const goals: string[] = []
    const research = cometTools({
      paths,
      retrieve: async () => [],
      research: async (goal) => {
        goals.push(goal)
        return 'a cited write-up is waiting in review'
      },
    }).find((t) => t.name === 'research')!
    expect(await research.run({ goal: 'what changed in the pricing page' }, CTX)).toContain('waiting in review')
    expect(goals).toEqual(['what changed in the pricing page'])
  })

  it('run_procedure hands the id and the filled blanks to the host', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-runproc'), { git: false })
    await addRoutine(paths, {
      name: 'Weekly report upload',
      steps: [
        { kind: 'open', url: 'https://portal.example/reports' },
        { kind: 'type', target: { text: 'Body' }, text: '{{summary}}' },
        { kind: 'click', target: { text: 'Submit' } },
      ],
    })
    const saved = (await listRoutines(paths))[0]!
    const calls: { id: string; slots: Record<string, string> }[] = []
    const tools = cometTools({
      paths,
      retrieve: async () => [],
      runProcedure: async (id, slots) => {
        calls.push({ id, slots })
        return 'the procedure finished'
      },
    })
    // find_procedure names the blanks so the loop knows what to fill.
    const found = await tools.find((t) => t.name === 'find_procedure')!.run({ task: 'weekly report' }, CTX)
    // The observation names the blank AND the exact next call, because a 2B
    // that is only told a blank exists reports it and stops (measured).
    expect(found).toContain('Blanks to fill: summary')
    expect(found).toContain(saved.id)
    expect(found).toContain('run_procedure')

    const run = tools.find((t) => t.name === 'run_procedure')!
    expect(await run.run({ id: saved.id, slots: { summary: 'shipped it' } }, CTX)).toBe('the procedure finished')
    expect(calls).toEqual([{ id: saved.id, slots: { summary: 'shipped it' } }])
    // A missing id is a question back, never a guess.
    expect(await run.run({}, CTX)).toContain('needs the procedure id')
  })
})

describe('propose_edit and propose_file — writing is always a proposal', () => {
  it('propose_edit raises a supersede card against the real note, and refuses a phantom', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-edit'), { git: false })
    const note = await createNote(paths, { body: '# Deploy\n\nFridays.' })
    const tools = cometTools({ paths, retrieve: async () => [] })
    const edit = tools.find((t) => t.name === 'propose_edit')!
    expect(await edit.run({ id: note.front.id, body: '# Deploy\n\nTuesdays now.' }, CTX)).toContain('review')
    const cards = await listCards(paths)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.cardType).toBe('supersede')
    expect(cards[0]!.targets).toEqual([note.front.id])
    // The note body itself is untouched until the person approves.
    expect((await readdir(paths.notes)).length).toBe(1)
    expect(await edit.run({ id: 'n-does-not-exist', body: 'x' }, CTX)).toContain('nothing to edit')
  })

  it('propose_file only exists with consented folders, and refuses a path outside them', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-file'), { git: false })
    expect(cometTools({ paths, retrieve: async () => [] }).map((t) => t.name)).not.toContain('propose_file')

    const tools = cometTools({
      paths,
      retrieve: async () => [],
      allowedFolders: async () => ['C:/Users/me/Documents/work'],
    })
    const file = tools.find((t) => t.name === 'propose_file')!
    expect(await file.run({ path: 'C:/Users/me/Documents/work/report.md', content: 'hello' }, CTX)).toContain('proposed')
    expect(await file.run({ path: 'C:/Users/me/Secrets/passwords.txt', content: 'x' }, CTX)).toContain('refused')
    // Only the allowed one became a card, and nothing was written anywhere.
    const cards = await listCards(paths)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.rationale).toContain('file: C:/Users/me/Documents/work/report.md')
  })

  it('with no folders allowed at all, a file proposal says so instead of guessing', async () => {
    const paths = await initVault(await tmpVaultRoot('tools-file-none'), { git: false })
    const file = cometTools({ paths, retrieve: async () => [], allowedFolders: async () => [] }).find(
      (t) => t.name === 'propose_file',
    )!
    expect(await file.run({ path: 'C:/anywhere/x.md', content: 'x' }, CTX)).toContain('no folders are allowed yet')
    expect(await listCards(paths)).toHaveLength(0)
  })
})

describe('insideAllowedFolder', () => {
  it('contains rather than prefix-matches, and never walks upward', () => {
    const folders = ['C:/Users/me/Documents/work']
    expect(insideAllowedFolder('C:/Users/me/Documents/work/a/b.md', folders)).toBe(true)
    expect(insideAllowedFolder('C:\\Users\\me\\Documents\\work\\a.md', folders)).toBe(true)
    // the classic near-miss: a sibling folder whose name starts the same
    expect(insideAllowedFolder('C:/Users/me/Documents/work-secret/a.md', folders)).toBe(false)
    expect(insideAllowedFolder('C:/Users/me/Documents/work/../../secrets.txt', folders)).toBe(false)
    expect(insideAllowedFolder('C:/elsewhere/a.md', folders)).toBe(false)
    expect(insideAllowedFolder('C:/anything', [])).toBe(false)
  })
})
