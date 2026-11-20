import { expect, it } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'

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
  expect(seen).toEqual(['반도체 수출 뉴스 다른 말로 results'])
  expect(result.answer).toContain('3. HBM 수출 최대')
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

it('c11b r3: the delivered answer is checked after every round; a list still short gets one line under it saying how many met the ask', async () => {
  let runs = 0
  const shortfall = (answer: string) => (answer.match(/^\d+\./gm) ?? []).length < 4 ? `링크까지 확인된 건 4개 중 ${(answer.match(/^\d+\./gm) ?? []).length}개예요.` : undefined
  const two = '1. 오션 운임 반등 [a](https://a.example/1)\n2. 컨테이너선 발주 [b](https://b.example/2)'
  const r = await runToolSession({ engine: brain(async () => (++runs === 1 ? { answer: '1. 오션 운임 반등 [a](https://a.example/1)' } : { answer: two })), workdir: WORKDIR, tools: [search] }, '해운 운임 기사 4개', { lookup: true, recheck: () => runs === 1 ? 'They asked for 4.' : undefined, shortfall })
  expect(runs).toBe(2)
  expect(r.answer).toBe(`${two}\n\n링크까지 확인된 건 4개 중 2개예요.`)
  runs = 0
  const kept = await runToolSession({ engine: brain(async () => (++runs === 1 ? { answer: '1. 하나 [a](https://a.example/1)' } : { answer: '' })), workdir: WORKDIR, tools: [search] }, '해운 운임 기사 4개', { lookup: true, recheck: () => 'They asked for 4.', shortfall })
  expect(kept.answer).toBe('1. 하나 [a](https://a.example/1)\n\n링크까지 확인된 건 4개 중 1개예요.')
  const full = await runToolSession({ engine: brain(async () => ({ answer: '1. a\n2. b\n3. c\n4. d' })), workdir: WORKDIR, tools: [search] }, '해운 운임 기사 4개', { lookup: true, shortfall })
  expect(full.answer).toBe('1. a\n2. b\n3. c\n4. d')
})

it('c12b r2: words said while the draft is judged or while its extra round runs rewrite the one answer, and the rewrite is judged', async () => {
  const waiting: string[] = [], prompts: string[] = [], judged: string[] = []
  const engine = brain(async job => {
    prompts.push(job.prompt)
    return { answer: prompts.length === 1 ? '1. 전기차 보조금 개편 [a](https://a.example/1)' : prompts.length === 2 ? '1. 수소차 충전소 확대 [h](https://h.example/1)' : '1. 수소차 충전소 확대 [h](https://h.example/1)\n2. 수소버스 도입 [k](https://k.example/2)' }
  })
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [search] }, '전기차 정책 기사 2개 찾아줘', {
    lookup: true, steerReplied: true, takeSteer: () => waiting.splice(0),
    recheck: async answer => {
      judged.push(answer)
      if (judged.length === 1) { await new Promise(resolve => setTimeout(resolve, 20)); waiting.push('아 전기차 말고 수소차로'); return 'They asked for 2.' }
      return 'They asked for 2.'
    },
  })
  expect(judged).toEqual(['1. 전기차 보조금 개편 [a](https://a.example/1)', '1. 수소차 충전소 확대 [h](https://h.example/1)'])
  expect(prompts[1]).toContain('아 전기차 말고 수소차로')
  expect(prompts[2]).toContain('수소차 충전소 확대')
  expect(result.answer).not.toContain('전기차 보조금')
  expect(waiting).toEqual([])

  const later: string[] = [], seen: string[] = []
  let runs = 0
  const r2 = await runToolSession({ engine: brain(async job => {
    seen.push(job.prompt); runs++
    if (runs === 2) later.push('경남 소식도 하나 넣어줘')
    return { answer: runs === 1 ? '1. 부산 항만 [p](https://p.example/1)' : runs === 2 ? '1. 부산 항만 [p](https://p.example/1)\n2. 울산 항만 [u](https://u.example/2)' : '1. 부산 항만 [p](https://p.example/1)\n2. 울산 항만 [u](https://u.example/2)\n3. 창원 항만 [c](https://c.example/3)' }
  }), workdir: WORKDIR, tools: [search] }, '항만 기사 2개', { lookup: true, takeSteer: () => later.splice(0), recheck: async () => runs === 1 ? 'They asked for 2.' : undefined })
  expect(runs).toBe(3)
  expect(seen[2]).toContain('경남 소식도 하나 넣어줘')
  expect(r2.answer).toContain('3. 창원 항만')
})

it('c12b r3 → k1: words said while the answer is being written rewrite it, and the rewrite is delivered exactly as the model wrote it, with nothing put after it', async () => {
  const waiting: string[] = [], prompts: string[] = []
  const first = '1. 망원동 호두 식빵집 [m](https://m.example/1)', second = '1. 연남동 소금빵집 [y](https://y.example/1)\n\n줄이 길어서 오전에 가는 게 좋아요.'
  const engine = brain(async job => {
    prompts.push(job.prompt)
    if (prompts.length === 1) waiting.push('망원 말고 연남동 빵집으로 찾아줘')
    return { answer: prompts.length === 1 ? first : second }
  })
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [search] }, '망원동 빵집 하나 알려줘', { lookup: true, steerReplied: true, takeSteer: () => waiting.splice(0) })
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
