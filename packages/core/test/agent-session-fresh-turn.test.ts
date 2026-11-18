import { expect, it } from 'vitest'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd, ToolSessionJob } from '../src/engine/types.js'

it.each([true, false])('requests fresh turn evidence only for desktop tasks (desktop=%s)', async (desktop) => {
  const jobs: ToolSessionJob[] = []
  const engine = { desktopToolIsolation: true, runTools: async (job: ToolSessionJob) => {
    jobs.push(job)
    return { answer: 'No input dispatched' }
  } } as Engine
  const tools = [{ name: desktop ? 'read_desktop' : 'search_memory', description: 'Read', argsSchema: {}, run: async () => 'Observed' }]
  const deps = { engine, workdir: 'C:/tmp' as EngineCwd, tools }
  await runToolSession(deps, 'Inspect the current state', { session: 'same-session' })
  await runToolSession(deps, 'Continue with a different value', { session: 'same-session' })
  for (const job of jobs) {
    expect(job.prompt.includes('Prior-turn desktop observations are historical')).toBe(desktop)
    if (desktop) {
      expect(job.prompt).toContain('app_read for background accessibility work')
      expect(job.prompt).toContain('read_desktop/look_desktop for foreground work')
      expect(job.prompt).toContain('reuse fresh returned observations within this turn')
    }
    expect(job.system).not.toContain('Prior-turn desktop observations are historical')
  }
  expect(jobs[0]!.system).toBe(jobs[1]!.system)
})

it('runs a light turn at low effort, and the next turn of the thread still holds what was said', async () => {
  const jobs: ToolSessionJob[] = []
  const engine = { runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: '정리했어요.' } } } as Engine
  const deps = { engine, workdir: 'C:/tmp' as EngineCwd, tools: [{ name: 'search_memory', description: 'Read', argsSchema: {}, run: async () => 'text' }] }
  await runToolSession(deps, 'fixtures/meeting-notes.md 회의록 요약해줘', { session: 'bot-1', light: true, history: [] })
  const history = [{ role: 'user' as const, text: 'fixtures/meeting-notes.md 회의록 요약해줘' }, { role: 'assistant' as const, text: '결정사항: 온보딩 화면 시안 확정. 할 일: 한서연 11월 20일.' }]
  await runToolSession(deps, '위 회의록으로 워드 보고서 만들어줘', { session: 'bot-1', history })
  await runToolSession(deps, '아 그거 말고 11월 걸로', { session: 'bot-1', lookup: true, history })
  expect(jobs.map(job => job.effort)).toEqual(['low', undefined, 'low'])
  expect(jobs[0]!.opening).toBeUndefined()
  for (const job of jobs.slice(1)) {
    expect(job.opening).toContain('fixtures/meeting-notes.md 회의록 요약해줘')
    expect(job.opening).toContain('한서연 11월 20일')
  }
})
