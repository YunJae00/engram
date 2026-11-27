import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { AgentTool, Engine, ToolSessionJob } from 'core'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/prompt.js'
import { answer, openWorld } from '../src/main/answer.js'

const engineOf = (lead: (job: ToolSessionJob, call: number) => Promise<string>): { engine: Engine; jobs: ToolSessionJob[] } => {
  const jobs: ToolSessionJob[] = []
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: await lead(job, jobs.length) } } } as unknown as Engine
  return { engine, jobs }
}
const searchText = async (job: ToolSessionJob, query: string): Promise<string> => {
  const out = await job.tools.find(tool => tool.name === 'search_web')!.run({ query })
  return typeof out === 'string' ? out : out.text
}
const inDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'c9a-swap-'))
  try { return await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('a replacement said mid-work reaches the running turn as the person said it, and the draft for the new subject is posted as written', async () => {
  await inDir(async dir => {
    const drafts = ['리스본은 지금 맑고 17도예요.', '포르투는 지금 구름 많고 15도예요. [포르투갈 기상청](https://www.ipma.pt/pt/)']
    const { engine, jobs } = engineOf(async (_job, call) => drafts[call - 1]!)
    const search: AgentTool = { name: 'search_web', description: 'searches the web', argsSchema: { type: 'object' }, run: async () => 'results for "x"\n1. x' }
    const waiting = ['아 리스본 말고 포르투로 봐 줄래']
    const { result } = await answer(await openWorld(dir, engine), '리스본 지금 날씨 좀 볼래', { tools: [search], takeSteer: () => waiting.splice(0) })
    expect(jobs).toHaveLength(2)
    expect(jobs[1]!.prompt).toContain('아 리스본 말고 포르투로 봐 줄래')
    expect(result?.answer).toBe(drafts[1])
  })
  expect(existsSync(new URL('../src/main/fast-lane.ts', import.meta.url))).toBe(false)
})

test.each([
  ['an addition', '아 교토 단풍 명소도 같이 찾아줘'],
  ['a remark', '생각보다 오래 걸리네'],
  ['a form change', '목록 말고 짧은 표로 보여줘'],
])('%s said while the search runs leaves that search running to its end and reaches the same model run in its result', async (_kind, said) => {
  await inDir(async dir => {
    const waiting: string[] = []
    let searchSignal: AbortSignal | undefined
    const search: AgentTool = { name: 'search_web', description: 'searches the web', argsSchema: { type: 'object' }, run: async (args, context) => {
      searchSignal = context.signal
      waiting.push(said)
      await new Promise(resolve => setTimeout(resolve, 40))
      return `results for "${String(args['query'])}"\n- 오사카 성 벚꽃 개화 — https://bloom.example/osaka`
    } }
    let seen = ''
    const { engine, jobs } = engineOf(async job => { seen = await searchText(job, '오사카 벚꽃 개화'); return '오사카 성은 다음 주에 피기 시작해요. [개화 소식](https://bloom.example/osaka)' })
    const { result, trace } = await answer(await openWorld(dir, engine), '오사카 벚꽃 언제 피는지 알아봐 줄래', { tools: [search], takeSteer: () => waiting.splice(0) })
    expect(jobs).toHaveLength(1)
    expect(searchSignal?.aborted).toBe(false)
    expect(seen).toContain('https://bloom.example/osaka')
    expect(seen).toContain(JSON.stringify(said))
    expect(result?.answer).toBe('오사카 성은 다음 주에 피기 시작해요. [개화 소식](https://bloom.example/osaka)')
    expect(trace.end).not.toBe('stop')
  })
})

test('a change said before the lead calls anything reaches the lead at its first call, and the search it runs is its own, on the new subject', async () => {
  await inDir(async dir => {
    const queries: string[] = []
    const search: AgentTool = { name: 'search_web', description: 'searches the web', argsSchema: { type: 'object' }, run: async args => { queries.push(String(args['query'])); return `results for "${String(args['query'])}"` } }
    const waiting = ['참, 강릉 말고 속초 쪽으로 해줘']
    const { engine, jobs } = engineOf(async job => {
      const first = await searchText(job, '강릉 바다 수온')
      if (!first.includes('속초')) return '강릉 바다는 지금 14도예요.'
      await searchText(job, '속초 바다 수온')
      return '속초 바다는 지금 13도예요.'
    })
    const { result } = await answer(await openWorld(dir, engine), '강릉 바다 수온 지금 몇 도야', { tools: [search], takeSteer: () => waiting.splice(0) })
    expect(jobs).toHaveLength(1)
    expect(queries).toEqual(['강릉 바다 수온', '속초 바다 수온'])
    expect(result?.answer).toBe('속초 바다는 지금 13도예요.')
  })
})

test('stopping the whole turn while a search hangs ends the turn, cancels that search and posts nothing', async () => {
  await inDir(async dir => {
    const turn = new AbortController()
    let searchSignal: AbortSignal | undefined
    const search: AgentTool = { name: 'search_web', description: 'searches the web', argsSchema: { type: 'object' }, run: (_args, context) => new Promise<string>((_, reject) => {
      searchSignal = context.signal
      context.signal?.addEventListener('abort', () => reject(new Error('canceled')), { once: true })
      setTimeout(() => turn.abort(), 20)
    }) }
    const { engine } = engineOf(async job => { await searchText(job, '제주 항공편 결항'); return '제주 항공편은 모두 정상이에요.' })
    const since = Date.now()
    const { result, trace } = await answer(await openWorld(dir, engine), '오늘 제주 가는 비행기 결항 있는지 봐줘', { tools: [search], signal: turn.signal })
    expect(Date.now() - since).toBeLessThan(3_000)
    expect(searchSignal?.aborted).toBe(true)
    expect(trace.end).toBe('stop')
    expect(result?.answer ?? '').not.toContain('정상')
  })
})

test('after a change the lead is told to name the new subject first, and its draft is posted as written whether or not it did', async () => {
  for (const draft of ['지금은 1파운드에 1,790원이에요.', '파운드는 지금 1,790원이에요. [환율](https://fx.example/gbp)']) {
    await inDir(async dir => {
      const waiting = ['유로 말고 파운드로']
      const { engine, jobs } = engineOf(async (_job, call) => call === 1 ? '유로는 지금 1,520원이에요.' : draft)
      const { result } = await answer(await openWorld(dir, engine), '유로 환율 얼마야', { tools: [], takeSteer: () => waiting.splice(0) })
      expect(jobs).toHaveLength(2)
      expect(jobs[1]!.system).toContain('A changed ask names the new subject first')
      expect(result?.answer).toBe(draft)
    })
  }
  expect(COLLEAGUE_CORE_RULE).toContain('A changed ask names the new subject first')
})
