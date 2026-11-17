import { expect, it } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'

// c11b (R3/H6): a list short of the count asked was cut by the host and led by a host-made count. Now the host only checks the shape and,
// with time left, gives the model one more round with the gap said; the answer is the model's.
const WORKDIR = 'C:/tmp' as EngineCwd
const brain = (script: (job: ToolSessionJob) => Promise<ToolSessionResult>): Engine => ({ id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), runTools: script } as unknown as Engine)
const search: AgentTool = { name: 'search_web', description: 'Search', argsSchema: {}, run: async args => `${String(args['query'])} results` }

it('c11b: a gap the host finds in the answer gets one more round with the draft and the gap said, and its calls again', async () => {
  const prompts: string[] = [], seen: string[] = [], checked: string[] = []
  const engine = brain(async job => {
    prompts.push(job.prompt)
    if (prompts.length === 1) return { answer: '1. 반도체 수출 11% 증가 [a](https://a.example/1)\n2. 메모리 단가 반등 [b](https://b.example/2)' }
    seen.push(await job.tools.find(t => t.name === 'search_web')!.run({ query: '반도체 수출 뉴스 다른 말로' }) as string)
    return { answer: '1. 반도체 수출 11% 증가 [a](https://a.example/1)\n2. 메모리 단가 반등 [b](https://b.example/2)\n3. HBM 수출 최대 [c](https://c.example/3)' }
  })
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [search] }, '이번 달 반도체 수출 뉴스 3개 찾아줘', {
    lookup: true, maxCalls: 1, deadlineMs: 5_000,
    recheck: answer => { checked.push(answer); return checked.length === 1 ? 'They asked for 3; 2 of this answer\'s items each have their own article link and its date.' : undefined },
  })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('You had just written this answer')
  expect(prompts[1]).toContain('메모리 단가 반등')
  expect(prompts[1]).toContain('They asked for 3')
  // One maxCall was used up by nobody, but the round gets its calls again: the search ran.
  expect(seen).toEqual(['반도체 수출 뉴스 다른 말로 results'])
  expect(result.answer).toContain('3. HBM 수출 최대')
  // Checked once only: the second answer stands whatever it holds.
  expect(checked).toHaveLength(1)
})

it('c11b: no gap, one round; a second round that writes nothing keeps the draft', async () => {
  let runs = 0
  const one = await runToolSession({ engine: brain(async () => { runs++; return { answer: '핀테크 투자 소식 4건이에요.' } }), workdir: WORKDIR, tools: [search] }, '요즘 국내 핀테크 투자 소식 4개만', { lookup: true, recheck: () => undefined })
  expect([runs, one.answer]).toEqual([1, '핀테크 투자 소식 4건이에요.'])
  runs = 0
  const empty = await runToolSession({ engine: brain(async () => (++runs === 1 ? { answer: '1. 하나 [a](https://a.example/1)' } : { answer: '' })), workdir: WORKDIR, tools: [search] }, '요즘 국내 핀테크 투자 소식 4개만', { lookup: true, recheck: () => 'They asked for 4.' })
  expect([runs, empty.answer]).toEqual([2, '1. 하나 [a](https://a.example/1)'])
})
