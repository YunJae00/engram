import { expect, it } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'

const WORKDIR = 'C:/tmp' as EngineCwd
const brain = (script: (job: ToolSessionJob) => Promise<ToolSessionResult>): Engine => ({ id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), runTools: script } as unknown as Engine)
const search: AgentTool = { name: 'search_web', description: 'Search', argsSchema: {}, run: async args => `${String(args['query'])} results` }

it('c11b r2: words written only before a tool call are a note; the turn gets one round to say its answer, and the note is not shown', async () => {
  const prompts: string[] = []
  const engine = brain(async job => {
    prompts.push(job.prompt)
    return prompts.length === 1 ? { answer: '', note: 'Let me pull the latest shipbuilding orders before answering.' } : { answer: '이번 달 조선 수주는 3건이에요.' }
  })
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [search] }, '이번 달 조선 수주 알려줘', { lookup: true, deadlineMs: 5_000 })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('wrote no answer after it')
  expect(result.answer).toBe('이번 달 조선 수주는 3건이에요.')
  expect(result.answer).not.toContain('Let me')
  let runs = 0
  const plain = await runToolSession({ engine: brain(async () => { runs++; return { answer: '맑아요.', note: 'Checking.' } }), workdir: WORKDIR, tools: [search] }, '부산 날씨', { lookup: true })
  expect([runs, plain.answer]).toEqual([1, '맑아요.'])
  runs = 0
  const kept = await runToolSession({ engine: brain(async () => (++runs === 1 ? { answer: '', note: '수요일 회의 기억해 둘게요.' } : { answer: '' })), workdir: WORKDIR, tools: [search] }, '수요일 회의 기억해', {})
  expect([runs, kept.answer]).toEqual([2, '수요일 회의 기억해 둘게요.'])
})

it('c11b r3: a note in a language the person did not write in is never the answer, even when both rounds say nothing', async () => {
  for (const note of ['Searching the web for results', '먼저 Bloomberg terminal feed 확인할게요.']) {
    let runs = 0
    const r = await runToolSession({ engine: brain(async () => (++runs === 1 ? { answer: '', note } : { answer: '' })), workdir: WORKDIR, tools: [search] }, '이번 주 해운 운임 기사 알려줘', { lookup: true })
    expect([runs, r.answer]).toEqual([2, ''])
  }
  let runs = 0
  const ok = await runToolSession({ engine: brain(async () => (++runs === 1 ? { answer: '', note: 'Figma 링크 기억해 둘게요.' } : { answer: '' })), workdir: WORKDIR, tools: [search] }, 'Figma 링크 기억해', {})
  expect(ok.answer).toBe('Figma 링크 기억해 둘게요.')
  runs = 0
  const en = await runToolSession({ engine: brain(async () => (++runs === 1 ? { answer: '', note: 'Noted the dentist on Friday.' } : { answer: '' })), workdir: WORKDIR, tools: [search] }, 'remember the dentist on Friday', {})
  expect(en.answer).toBe('Noted the dentist on Friday.')
})

it('c12b r3 → k1: words said while the answer is being written rewrite it, and the rewrite is delivered exactly as the model wrote it, with nothing put after it', async () => {
  const waiting: string[] = [], prompts: string[] = []
  const first = '1. 망원동 호두 식빵집 [m](https://m.example/1)', second = '1. 연남동 소금빵집 [y](https://y.example/1)\n\n줄이 길어서 오전에 가는 게 좋아요.'
  const engine = brain(async job => {
    prompts.push(job.prompt)
    if (prompts.length === 1) waiting.push('망원 말고 연남동 빵집으로 찾아줘')
    return { answer: prompts.length === 1 ? first : second }
  })
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [search] }, '망원동 빵집 하나 알려줘', { lookup: true, takeSteer: () => waiting.splice(0) })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('망원 말고 연남동 빵집으로 찾아줘')
  expect(prompts[1]).toContain(first)
  expect(result.answer).toBe(second)
  expect(result.files).toEqual([])
  expect(waiting).toEqual([])

  let runs = 0
  const silent = await runToolSession({ engine: brain(async () => { runs++; return { answer: '' } }), workdir: WORKDIR, tools: [search] }, '합정 도서관 개관일', { lookup: true, takeSteer: () => [] })
  expect([runs, silent.answer]).toEqual([1, ''])
})
