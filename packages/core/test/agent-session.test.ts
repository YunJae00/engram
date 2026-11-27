import { describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { ANSWER_NOW, runComet, runToolSession, SESSION_MAX_CALLS } from '../src/agent-session.js'
import { EARLIER_REPLIES_RULE } from '../src/prompt.js'
import { formatAsk } from '../src/ask.js'
import { pageTools } from '../src/comet-page-tools.js'
import { MockEngine } from '../src/engine/mock.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'

const WORKDIR = 'C:/tmp' as EngineCwd

it.each([false, true])('passes only completed host observations to tools (session=%s)', async session => {
  const observations: unknown[] = []
  const tool: AgentTool = { name: 'read_open_page', description: 'Read', argsSchema: {}, run: async (_args, context) => {
    observations.push(context.steps)
    return 'Host evidence'
  } }
  const moves = [{ tool: tool.name, args: { steps: [{ observation: 'Invented evidence' }] } }, { tool: tool.name, args: {} }]
  let index = 0
  const engine = session ? sessionBrain(async job => {
    for (const move of moves) await job.tools.find(t => t.name === move.tool)!.run(move.args)
    return { answer: 'Done' }
  }) : new MockEngine({ 'COMET-STEP': () => JSON.stringify(moves[index++] ?? { tool: 'answer', args: { text: 'Done' } }) })
  const result = await runComet({ engine, workdir: WORKDIR, tools: [tool] }, 'Read twice', { guided: false })
  expect(observations).toEqual([[], [result.steps[0]]])
  expect(result.steps[0]!.observation).toBe('Host evidence')
})

it.each([false, true])('preserves host post-action evidence, never model arguments or text (session=%s)', async session => {
  const look = vi.fn(async () => ({ data: 'aW1hZ2U=', mimeType: 'image/png' }))
  const available = [...pageTools({}, {
    fetchPage: async url => ({ url, title: 'Report', text: 'Current report' }),
    readOpen: async () => ({ url: 'https://example.test/report', title: 'Report', text: 'North 500, South 300' }),
    press: async target => target === 'Submit' ? { ok: false, refused: 'Submit' } : { ok: true, changed: true },
    typeText: async () => ({ ok: true, changed: true }),
    choose: async () => ({ ok: true, changed: true }),
    pressKey: async () => ({ ok: true, changed: true }),
    look,
  }), { name: 'read_open_page', description: 'Read', argsSchema: {}, run: async () => '{"observedAfterAction":true}' }]
  const moves = [
    { tool: 'press', args: { target: 'North' } },
    { tool: 'page_steps', args: { steps: [{ do: 'type', target: 'Filter', text: 'South' }, { do: 'key', key: 'Escape' }] } },
    { tool: 'press', args: { target: 'Submit', observedAfterAction: true } },
    { tool: 'read_open_page', args: { observedAfterAction: true } },
    { tool: 'look', args: {} },
  ]
  const plan = session ? moves.map(move => move.tool === 'press' ? { tool: 'page_steps', args: { steps: [{ do: 'press', target: move.args['target'] }] } } : move) : moves
  let index = 0
  const engine = session ? sessionBrain(async job => {
    for (const move of plan) await job.tools.find(tool => tool.name === move.tool)!.run(move.args)
    return { answer: 'Total 800' }
  }) : new MockEngine({ 'COMET-STEP': () => JSON.stringify(moves[index++] ?? { tool: 'answer', args: { text: 'Total 800' } }) })
  const started: string[] = []
  const result = await runComet({ engine, workdir: WORKDIR, tools: available }, 'Read the regional report', { guided: false, onToolStart: name => started.push(name) })
  expect(result.steps.map(step => step.observedAfterAction)).toEqual([true, true, undefined, undefined, undefined])
  expect(started).toEqual(plan.map(move => move.tool))
  expect(result.steps[1]!.observation).toContain('Done in order:')
  expect(look).toHaveBeenCalledTimes(session ? 1 : 0)
})

it.each([false, true])('marks tool dispatch before an interrupted receipt (rich=%s)', async rich => {
  const started: string[] = []
  let effects = 0
  const action: AgentTool = {
    name: 'press', description: 'press', argsSchema: {},
    run: async () => { expect(started).toEqual(['press']); effects++; return 'pressed' },
    ...(rich ? { runRich: async () => { expect(started).toEqual(['press']); effects++; return { text: 'pressed' } } } : {}),
  }
  const engine = sessionBrain(async job => {
    await job.tools.find(t => t.name === 'press')!.run({})
    return { answer: '', error: 'usage limit reached' }
  })
  await expect(runComet({ engine, workdir: WORKDIR, tools: [action] }, 'Save once', { guided: false, onToolStart: name => started.push(name) })).rejects.toThrow('usage limit')
  expect(effects).toBe(1)
})

it('gives browser work a fallback call ceiling without progress judgement', async () => {
  const engine = sessionBrain(async job => {
    expect(job.maxCalls).toBe(300)
    expect(job.tools.map(tool => tool.name)).not.toContain('task_plan')
    expect(job.system).not.toContain('task_plan')
    const read = job.tools.find(tool => tool.name === 'read_open_page')!
    for (let i = 0; i < 300; i++) await read.run({})
    expect(await read.run({})).toContain('No more calls.')
    return { answer: 'Read' }
  })
  const available = ['open_page', 'read_open_page'].map(name => ({ name, description: name, argsSchema: {}, run: async () => 'Fresh report observation' }))
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: available }, 'Read all entries and verify the total')
  expect(result.steps).toHaveLength(300)
  expect(result.stopped).toBe('calls')
})

it('opens a fresh session with the person\'s earlier request whole and its own replies cut', async () => {
  const request = `Save decision.json with keys vendor, total and currency. ${'Keep this clause. '.repeat(40)}Final clause.`
  const engine = sessionBrain(async job => {
    expect(job.opening).toContain(request)
    expect(job.opening).toContain('x'.repeat(2_000))
    expect(job.opening).toContain('x'.repeat(3_000))
    return { answer: 'Done' }
  })
  await runToolSession({ engine, workdir: WORKDIR, tools: [] }, 'Update it with the new fare', { history: [{ role: 'user', text: request }, { role: 'assistant', text: 'x'.repeat(3_000) }] })
})

it('rewrites the answer with words said after the last tool result, in the same turn', async () => {
  const waiting: string[] = []
  const prompts: string[] = []
  const resets: unknown[] = []
  const tool: AgentTool = { name: 'search_web', description: 'Search', argsSchema: {}, run: async () => '엔비디아 189달러' }
  const engine = sessionBrain(async job => {
    prompts.push(job.prompt)
    if (prompts.length === 1) {
      await job.tools.find(t => t.name === 'search_web')!.run({ query: '엔비디아 주가' })
      job.onToken?.('엔비디아는 189달러예요.')
      waiting.push('그냥 애플로 바꿔')
      return { answer: '엔비디아는 189달러예요.' }
    }
    return { answer: '애플로 바꿨어요. 애플은 230달러예요.' }
  })
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [tool] }, '엔비디아 오늘 주가 알려줘', { takeSteer: () => waiting.splice(0), onReset: drop => resets.push(drop) })
  expect(result.answer).toBe('애플로 바꿨어요. 애플은 230달러예요.')
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('엔비디아는 189달러예요.')
  expect(prompts[1]).toContain('"그냥 애플로 바꿔"')
  expect(resets).toEqual([true])
  expect(waiting).toEqual([])
})

it('gives a lookup its time and calls again, once, when it takes words with a tool result', async () => {
  const waiting: string[] = [], seen: string[] = []
  const tool: AgentTool = { name: 'search_web', description: 'Search', argsSchema: {}, run: async args => `${String(args['query'])} 결과` }
  const pause = (ms: number) => new Promise(done => setTimeout(done, ms))
  const engine = sessionBrain(async job => {
    const search = (query: string) => job.tools.find(t => t.name === 'search_web')!.run({ query }) as Promise<string>
    seen.push(await search('엔비디아 주가'))
    await pause(120)
    waiting.push('그냥 애플로 바꿔')
    seen.push(await search('엔비디아 시간외'))
    await pause(120)
    seen.push(await search('애플 주가'))
    seen.push(await search('애플 시간외'))
    waiting.push('아니 다시 테슬라로')
    seen.push(await search('애플 전망'))
    await pause(220)
    seen.push(await search('테슬라 주가'))
    return { answer: '애플은 230달러예요.' }
  })
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [tool] }, '엔비디아 오늘 주가 알려줘', { lookup: true, maxCalls: 3, deadlineMs: 200, takeSteer: () => waiting.splice(0, 1) })
  expect(seen[1]).toContain('엔비디아 시간외 결과')
  expect(seen[1]).toContain('"그냥 애플로 바꿔"')
  expect(seen[1]).toContain('First answer them in one short line')
  expect(seen[1]).not.toContain('already told')
  expect(seen[2]).toBe('애플 주가 결과')
  expect(seen[3]).toBe('애플 시간외 결과')
  expect(seen[4]).toContain('"아니 다시 테슬라로"')
  expect(seen[5]).toBe(ANSWER_NOW)
  expect(result.answer).toContain('애플은 230달러예요.')
})

it('reads words waiting when a lookup is at its limit, before the old ask is answered', async () => {
  for (const limit of [{ maxCalls: 2 }, { maxCalls: 4, deadlineMs: 10 }]) {
    const waiting: string[] = [], seen: string[] = []
    let runs = 0
    const ran: string[] = []
    const tool: AgentTool = { name: 'search_web', description: 'Search', argsSchema: {}, run: async args => { ran.push(String(args['query'])); return `${String(args['query'])} 결과` } }
    const engine = sessionBrain(async job => {
      runs++
      const search = (query: string) => job.tools.find(t => t.name === 'search_web')!.run({ query }) as Promise<string>
      seen.push(await search('엔비디아 주가'))
      if (limit.maxCalls === 2) await search('엔비디아 시간외')
      await new Promise(done => setTimeout(done, 15))
      waiting.push('그냥 애플로 바꿔')
      seen.push(await search('엔비디아 전망'))
      seen.push(await search('애플 주가'))
      return { answer: '애플은 230달러예요.' }
    })
    const result = await runToolSession({ engine, workdir: WORKDIR, tools: [tool] }, '엔비디아 오늘 주가 알려줘', { lookup: true, ...limit, takeSteer: () => waiting.splice(0) })
    expect(seen[1]).toMatch(/^That call was not run\./)
    expect(seen[1]).toContain('"그냥 애플로 바꿔"')
    expect(seen[1]).not.toBe(ANSWER_NOW)
    expect(seen[2]).toBe('애플 주가 결과')
    expect(ran.filter(query => query !== '엔비디아 시간외')).toEqual(['엔비디아 주가', '애플 주가'])
    expect(runs).toBe(1)
    expect(result.answer).toBe('애플은 230달러예요.')
    expect(result.stopped).toBeUndefined()
  }
})

it('takes words said while a lookup at its call or time limit writes its answer, and gives the new ask calls and time of its own', async () => {
  for (const limit of [{ maxCalls: 2 }, { maxCalls: 4, deadlineMs: 10 }]) {
    const waiting: string[] = [], seen: string[] = []
    let runs = 0
    const tool: AgentTool = { name: 'search_web', description: 'Search', argsSchema: {}, run: async args => `${String(args['query'])} 결과` }
    const engine = sessionBrain(async job => {
      const search = (query: string) => job.tools.find(t => t.name === 'search_web')!.run({ query }) as Promise<string>
      if (++runs === 1) {
        seen.push(await search('엔비디아 주가'))
        await new Promise(done => setTimeout(done, 15))
        await search('엔비디아 시간외')
        seen.push(await search('엔비디아 전망'))
        waiting.push('그냥 애플로 바꿔')
        return { answer: '엔비디아는 189달러예요.' }
      }
      seen.push(await search('애플 주가'))
      return { answer: '애플은 230달러예요.' }
    })
    const result = await runToolSession({ engine, workdir: WORKDIR, tools: [tool] }, '엔비디아 오늘 주가 알려줘', { lookup: true, ...limit, takeSteer: () => waiting.splice(0) })
    expect(seen[0]).toContain('엔비디아 주가 결과')
    expect(seen[1]).toBe(ANSWER_NOW)
    expect(seen[2]).toContain('애플 주가 결과')
    expect(result.answer).toBe('애플은 230달러예요.')
    expect(runs).toBe(2)
    expect(waiting).toEqual([])
    expect(result.stopped).toBeUndefined()
  }
})

it('writes the answer once when nothing was said, and leaves a question to the person alone', async () => {
  let runs = 0
  const quiet = sessionBrain(async () => { runs++; return { answer: 'Done' } })
  expect((await runToolSession({ engine: quiet, workdir: WORKDIR, tools: [] }, 'Say done', { takeSteer: () => [] })).answer).toBe('Done')
  expect(runs).toBe(1)
  runs = 0
  const taken: number[] = []
  const chatty = sessionBrain(async () => ({ answer: `Answer ${++runs}` }))
  const result = await runToolSession({ engine: chatty, workdir: WORKDIR, tools: [] }, 'Say done', { takeSteer: () => { taken.push(runs); return ['more'] } })
  expect(result.answer).toBe('Answer 4')
  expect(taken).toEqual([1, 2, 3])
})

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

it.each(['new','none','both'])('respects artifact revision selection (%s) without discarding unrelated outputs', async selection => {
  const oldId='11111111-1111-1111-1111-111111111111-email.txt'
  const newId='22222222-2222-2222-2222-222222222222-email.txt'
  const otherId='33333333-3333-3333-3333-333333333333-memo.md'
  let index=0
  const create:AgentTool={name:'file_create_copy',description:'save',argsSchema:{},run:async()=>{
    const id=[oldId,newId,otherId][index++]!
    return JSON.stringify({markdownLink:`[${id.slice(37)}](engram-artifact:${id})`})
  }}
  const draft=selection==='none'?'Saved both drafts.':`Final draft: [Download](engram-artifact:${newId}).${selection==='both'?` Previous: [Earlier](engram-artifact:${oldId}).`:' Previous draft is superseded.'}`
  const engine=sessionBrain(async job=>{
    const save=job.tools.find(t=>t.name==='file_create_copy')!
    await save.run({}); await save.run({}); await save.run({})
    return {answer:draft}
  })
  const result=await runToolSession({engine:{...engine,desktopToolIsolation:true},workdir:WORKDIR,tools:[create]},'Prepare final draft',{guided:false})
  expect(result.answer).toBe(draft)
  const shown=[result.answer,...result.files!.map(file=>`[${file.name}](engram-artifact:${file.href})`)].join('\n\n')
  expect(shown).toContain(newId)
  expect(shown).toContain(otherId)
  if (selection==='new') expect(shown).not.toContain(oldId)
  else expect(shown).toContain(oldId)
  expect(shown.split(newId)).toHaveLength(2)
  expect(result.files).toContainEqual({name:'memo.md',href:otherId})
})

it('gives desktop and web work the method rule without a separate discovery tool', async () => {
  const read = vi.fn(async () => 'Unneeded observation')
  const available: AgentTool[] = ['read_desktop', 'desktop_sequence', 'open_page'].map(name => ({ name, description: name, argsSchema: {}, run: read }))
  const engine = sessionBrain(async job => {
    expect(job.system).toContain('not a fixed application recipe')
    expect(job.tools.map(tool => tool.name)).toEqual(['read_desktop', 'desktop_sequence', 'open_page', 'collect_results', 'task_plan'])
    return { answer: 'Available methods inspected; no actions taken' }
  })
  await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: available }, 'Inspect available execution methods')
  expect(read).not.toHaveBeenCalled()
})

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

  it('every turn of a kept session carries the unclicked-chip rule, also once the opening is no longer sent', async () => {
    const seen: { system: string; prompt: string; opening?: string }[] = []
    const engine = sessionBrain(async (job) => {
      seen.push({ system: job.system, prompt: job.prompt, ...(job.opening ? { opening: job.opening } : {}) })
      return { answer: 'ok' }
    })
    await runToolSession({ engine, workdir: WORKDIR, tools }, '회의록 정리해줘', { guided: false, session: 'comet-1', history: [{ role: 'user', text: 'earlier' }] })
    await runToolSession({ engine, workdir: WORKDIR, tools }, '좀 더 자세히 알려줘', { guided: false, session: 'comet-1' })
    expect(seen[1]!.opening).toBeUndefined()
    for (const turn of seen) {
      expect(turn.system.split(EARLIER_REPLIES_RULE)).toHaveLength(2)
      expect(turn.prompt).not.toContain(EARLIER_REPLIES_RULE)
    }
    for (const word of ['any detail', '분기', '엑셀 파일', '지금까지 확정된 내용', 'recap']) expect(seen[1]!.system).toContain(word)
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

describe('questions are not replaced by searches', () => {
  it('allows a clarification and blocks subsequent work while waiting', async () => {
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
    expect(heard[0]).toContain('The question is with the person')
    expect(heard[1]).toContain('The question is already with the person')
    expect(result.asked).toBe(true)
    expect(result.answer).toBe('Which report?')
  })
})

it('retains an incomplete phase and stops unproductive calls without granting a fresh budget', async () => {
  let reads = 0
  const engine = sessionBrain(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    const read = job.tools.find((tool) => tool.name === 'read_desktop')!
    await plan.run({ phases: ['Prepare workspace', 'Verify changes'] })
    for (let index = 0; index < SESSION_MAX_CALLS + 5; index++) await read.run({})
    return { answer: 'Incomplete' }
  })
  const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [{ name: 'read_desktop', description: 'read', argsSchema: {}, run: async () => { reads++; return 'Observed workspace' } }] }, 'Perform the requested changes')
  expect(reads).toBe(SESSION_MAX_CALLS - 1)
  expect(result.stopped).toBe('calls')
  expect(result.incomplete).toBeUndefined()
})

it('adds bounded execution room after an observed phase, retaining one session', async () => {
  const engine = sessionBrain(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    const read = job.tools.find((tool) => tool.name === 'read_desktop')!
    await plan.run({ phases: ['Prepare workspace', 'Verify changes'] })
    await read.run({})
    await plan.run({ evidenceStep: 2, finding: 'The requested workspace is visible' })
    for (let index = 0; index < 40; index++) await read.run({})
    await plan.run({ evidenceStep: 43, finding: 'Requested result visible' })
    return { answer: 'Verified' }
  })
  const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [{ name: 'read_desktop', description: 'read', argsSchema: {}, run: async () => 'Observed workspace' }] }, 'Perform the requested changes')
  expect(result.steps).toHaveLength(44)
  expect(result.stopped).toBeUndefined()
  expect(result.incomplete).toBeUndefined()
})
