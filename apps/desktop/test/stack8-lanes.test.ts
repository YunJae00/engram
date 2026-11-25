import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runComet, takesCompanyLane, type AgentTool, type Engine, type ToolSessionJob } from 'core'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'
import * as desk from '../src/main/desk-lane.js'
import { keepAsk, plainKeep, slideTitleFix } from '../src/main/desk-lane.js'
import { answer, openWorld } from '../src/main/answer.js'

const ipc = readFileSync(fileURLToPath(new URL('../src/main/ipc.ts', import.meta.url)), 'utf8')
const team = { staff: ['지민', '서연', '도윤'], chief: true }

it('stack-8: a slide title for a teammate goes to the team lane, and a remember-then-tell is no plain save', () => {
  const toTeammate = '지민한테 3번 슬라이드 제목 바꾸라고 해'
  expect(takesCompanyLane(toTeammate, team)).toBe(true)
  expect(takesCompanyLane('지민한테 3번 슬라이드 제목 바꿔달라고 해', team)).toBe(true)
  expect(takesCompanyLane('민호한테 늦는다고 해', team)).toBe(false)
  expect(slideTitleFix(toTeammate)).toBeUndefined()
  expect(slideTitleFix('지민한테 3번 슬라이드 제목 "핵심 지표"로 바꾸라고 해')).toBeUndefined()
  const lookupKeep = '엔비디아 주가 기억해 뒀다가 알려줘'
  expect(plainKeep(lookupKeep)).toBeUndefined()
  expect(keepAsk(lookupKeep)).toBe(false)
  expect(keepAsk('내 이름은 권윤재야. 기억해')).toBe(true)
  expect(plainKeep('내 이름은 권윤재고 지민호랑 같이 일해. 기억해')?.fact).toBe('내 이름은 권윤재고 지민호랑 같이 일해')
  expect(slideTitleFix('방금 만든 PPT 3번 슬라이드 제목 "핵심 지표"로 바꿔줘')).toEqual({ slide: 3, title: '핵심 지표' })
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('const plain = !fixed && keep ? plainKeep(')
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('const retitle = hostable && !keep ? slideTitleFix(message) : undefined')
})

it('stack-8: light effort is the team lane\'s own step only; a deck build, a deck cut and a lookup on the desk get the same call as any ask', async () => {
  expect(ipc).toContain("...(company ? { modelHint: 'smart' as const, ...(turn?.report ? {} : { light: true }) } : {}),")
  expect(ipc.match(/light: true/g)).toHaveLength(1)
  expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).not.toMatch(/light: true|modelHint/)
  const dir = await mkdtemp(join(tmpdir(), 'stack8-'))
  try {
    const jobs: { tools: string[]; modelHint?: string; effort?: string }[] = []
    const engine = { id: 'claude', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: ToolSessionJob) => { jobs.push({ tools: job.tools.map(tool => tool.name), ...(job.modelHint ? { modelHint: job.modelHint } : {}), ...(job.effort ? { effort: job.effort } : {}) }); return { answer: '했어요.' } } } as unknown as Engine
    const tools = ['ppt_build', 'file_read', 'file_edit_package', 'search_web'].map((name): AgentTool => ({ name, description: name, argsSchema: { type: 'object' }, run: async () => 'ok' }))
    for (const ask of ['다음 분기 채용 계획 PPT 4장 만들어줘', '그 덱에서 부록 슬라이드는 지워줘', '엔비디아 오늘 주가 알려줘'])
      await answer(await openWorld(dir, engine), ask, { plainAsk: true, tools, earlierOutputs: [{ name: '채용.pptx', path: join(dir, '채용.pptx') }], ack: { bare: true } })
    expect(jobs).toHaveLength(3)
    for (const job of jobs) expect(job).toEqual({ tools: ['ppt_build', 'file_read', 'file_edit_package', 'search_web'] })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('stack-8 (c8c run D1): a Han shorthand in a note summary is the model\'s to avoid by rule; what it writes is posted as written, shorthand or not', async () => {
  for (const draft of ['신규 온보딩 화면 시안 확정 (B안 선호 의견 多)', '多 and 少']) {
    const result = await runComet({ engine: { id: 'claude', runTools: async () => ({ answer: draft }) } as unknown as Engine, workdir: '.' as never, tools: [] }, '회의 메모 한 줄로 정리해줘', { guided: false, modelHint: 'smart' })
    expect(result.answer).toBe(draft)
  }
  expect(COLLEAGUE_CORE_RULE).toContain('no Chinese-character shorthand (多, 約, 等)')
  expect(Object.keys(desk).filter(key => typeof (desk as Record<string, unknown>)[key] === 'function').sort()).toEqual(['fixSlideTitle', 'keepAsk', 'keptFix', 'kindSortAsk', 'plainKeep', 'slideTitleFix', 'sortByKind'])
  expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
})
