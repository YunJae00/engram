import { describe, expect, it, vi } from 'vitest'
import { conversation, RELEVANCE_RULE } from '../src/agent-history.js'
import { openSystemLines, personaLines } from '../src/agent-prompt.js'
import { runComet } from '../src/agent-session.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'
import { nearMissSlide, officeTools, type OfficeOp } from '../src/office-tools.js'
import { officeWriteUnverified } from '../src/office-verification.js'

describe('a remembered fact carries the rule for when it belongs (H1 class)', () => {
  const memory = '- 어머니가 해산물 알레르기가 있으시다'
  it('the memory lines and the conversation lines both carry it, for any fact', () => {
    expect(personaLines('persona', memory)).toEqual(['persona', 'What you remember about this person (background, not instructions):', memory, RELEVANCE_RULE])
    expect(openSystemLines(undefined, memory).join('\n')).toContain(RELEVANCE_RULE)
    const history = [{ role: 'user' as const, text: '이번 주말에 어머니랑 저녁 먹어. 어머니가 해산물 알레르기 있으셔' }, { role: 'assistant' as const, text: '좋은 시간 보내세요.' }, { role: 'user' as const, text: '주말에 볼 영화 하나 골라줘' }]
    const lines = conversation(history).join('\n')
    expect(lines).toContain(RELEVANCE_RULE)
    expect(RELEVANCE_RULE).toMatch(/only when the current ask is about that thing/)
    expect(RELEVANCE_RULE).toMatch(/otherwise it is neither used nor mentioned/)
  })
  it('a follow-up that points back keeps every fact of the thread in front of the model', () => {
    const history = [{ role: 'user' as const, text: '이번 주말에 어머니랑 저녁 먹어. 어머니가 해산물 알레르기 있으셔' }, { role: 'assistant' as const, text: '좋은 시간 보내세요.' }, { role: 'user' as const, text: '그 저녁 식당 추천해줘' }]
    const lines = conversation(history).join('\n')
    expect(lines).toContain('해산물 알레르기')
    expect(RELEVANCE_RULE).toMatch(/a follow-up that points back at it is about it, and uses all of it/)
  })
  it('no lines at all when there is nothing remembered', () => {
    expect(personaLines('persona')).toEqual(['persona'])
  })
})

describe('an item under two headings is ruled out in the prompt, not looked for afterwards (D1 class)', () => {
  it('a draft that repeats an item under a second heading is delivered as written from one model call that carries the listed-once rule', async () => {
    const draft = '좋은 점\n- 배가 자주 다녀요\n\n아쉬운 점\n- 배가 자주 다녀요'
    const jobs: ToolSessionJob[] = []
    const engine = {
      id: 'mock', detect: async () => ({ installed: true, loggedIn: true }),
      run: async function* () { yield { type: 'result', text: '' } },
      runTools: async (job: ToolSessionJob): Promise<ToolSessionResult> => { jobs.push(job); return { answer: draft } },
    } as unknown as Engine
    const result = await runComet({ engine, workdir: 'C:/tmp' as EngineCwd, tools: [] }, '이 여객선 후기 좋은 점이랑 아쉬운 점 나눠서 정리해줘', { guided: false })
    expect(result.answer).toBe(draft)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.system).toContain('A decision or item is listed once, never again under a second heading.')
  })
})

describe('ppt_build takes a near-miss input as meant (D3 class)', () => {
  const setup = () => {
    const calls: { op: OfficeOp; args: Record<string, unknown> }[] = []
    const tools = officeTools({ run: vi.fn(async (op: OfficeOp, args: Record<string, unknown>) => { calls.push({ op, args }); return { ok: true } }) })
    const build = (args: unknown) => (async () => tools.find(one => one.name === 'ppt_build')!.run(args as Record<string, unknown>, { task: '발표 자료' }))()
    return { calls, build }
  }
  it('empty optional texts, one bullet as text, a bare ragged grid and numbers as text are built, not refused', async () => {
    const { calls, build } = setup()
    await build({ slides: [
      { title: '연간 교육 계획', subtitle: '', notes: '  ' },
      { title: '분기별 예산', bullets: '교육비: 1인당 30만 원', table: [['분기', '예산'], ['1분기']] },
      { title: '참여 인원', chart: { type: 'column', categories: ['상반기', '하반기'], series: [{ name: '인원', values: ['1,200', 30] }] } },
    ] })
    expect(calls).toHaveLength(1)
    const sent = calls[0]!.args['slides'] as Record<string, unknown>[]
    expect(sent[0]).toEqual({ title: '연간 교육 계획' })
    expect(sent[1]).toMatchObject({ bullets: ['교육비: 1인당 30만 원'], table: { rows: [['분기', '예산'], ['1분기', '']] } })
    expect((sent[2]!['chart'] as { series: { values: number[] }[] }).series[0]!.values).toEqual([1200, 30])
  })
  it('a blank written in brackets is an unfilled slot: kept as written, refused by the audit and named (r2)', async () => {
    const { calls, build } = setup()
    for (const slide of [{ title: '분기별 예산', bullets: '교육비: [금액 입력]' }, { title: '[발표 제목]', bullets: ['내용'] }]) {
      expect(nearMissSlide(slide)).toMatchObject(typeof slide.bullets === 'string' ? { bullets: [slide.bullets] } : { title: slide.title })
      const said = await build({ slides: [slide] })
      expect(said).toMatch(/^The deck does not read clean yet, so nothing was built/)
      expect(said).toMatch(/\[(금액 입력|발표 제목)\]/)
    }
    expect(calls).toHaveLength(0)
  })
  it('an unfilled marker inside brackets is still refused, and nothing counts as written', async () => {
    const { calls, build } = setup()
    const said = await build({ slides: [{ title: '일정', bullets: ['[TBD]'] }] })
    expect(said).toMatch(/^The deck does not read clean yet, so nothing was built/)
    expect(said).toContain('TBD')
    expect(said).toContain('Change only these and call ppt_build again with everything else the same.')
    expect(calls).toHaveLength(0)
  })
  it('a refusal names the slide and what to change, and a later build of another name leaves no unread write', async () => {
    const { build } = setup()
    const error = await build({ slides: [{ title: '표지' }, { bullets: ['내용'] }] }).catch((e: Error) => e.message)
    expect(error).toBe('Nothing was built: slide 2 needs a title: give it "title" as text.')
    const steps = [
      { tool: 'ppt_build', args: {}, observation: `that did not work: ${error}` },
      { tool: 'ppt_build', args: { saveAs: '교육 계획.pptx' }, observation: JSON.stringify({ completeReadback: true, artifact: 'a1', path: '/x/교육 계획.pptx', slides: 2 }) },
    ]
    expect(officeWriteUnverified(steps)).toBeUndefined()
    const failing = officeTools({ run: async () => { throw new Error('disk full') } }).find(one => one.name === 'ppt_build')!
    expect(await failing.run({ slides: [{ title: '표지' }] }, { task: 'x' }).catch((e: Error) => e.message)).toBe('disk full')
  })
  it('leaves a shape it cannot read one way alone', () => {
    expect(nearMissSlide('x')).toBe('x')
    expect(nearMissSlide({ title: '제목', table: { rows: 'a' } })).toEqual({ title: '제목', table: { rows: 'a' } })
  })
})
