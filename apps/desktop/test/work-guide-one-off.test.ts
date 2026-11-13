import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { initVault, listTasks, NoteStore, type Engine, type EngineJobInput } from 'core'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: () => undefined }))
vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
import { taskRunner, type TurnOutcome } from '../src/main/task-runner.js'
import { holdTaskResult } from '../src/main/task-result-state.js'
import { guideSettled, learnFromAnswer } from '../src/main/work-guide-learn.js'

const RULE = JSON.stringify({ sections: [{ heading: 'Rules', lines: ['External recipients need approval'] }] })

async function answered(goal: string, question: string, answer: string) {
  await mkdir(resolve('tmp'), { recursive: true })
  const paths = await initVault(join(await mkdtemp(resolve('tmp/work-guide-one-off-')), 'vault'), { git: false })
  const jobs: EngineJobInput[] = []
  const engine = { id: 'mock', async *run(job: EngineJobInput) { jobs.push(job); yield { type: 'result', text: RULE } } } as unknown as Engine
  const ctx = { paths, engines: [engine], store: await NoteStore.open(paths) } as unknown as Parameters<typeof learnFromAnswer>[0]
  let turns = 0, last: TurnOutcome | undefined
  const runner = taskRunner({
    paths,
    send: async (_request, extra) => {
      last = ++turns === 1 ? { answer: question, asked: true, unfinished: false, steps: 1 } : { answer: 'ok', asked: false, unfinished: false, steps: 0 }
      last.held = holdTaskResult({ answer: last.answer, steps: [], asked: last.asked }, extra)
    },
    outcome: () => { const o = last; last = undefined; return o },
    abort: () => undefined,
    broadcast: () => undefined,
    remember: async () => undefined,
    notify: () => undefined,
    deliver: async () => undefined,
    learn: (q, a, g) => learnFromAnswer(ctx, q, a, g),
  })
  const settle = (state: string) => vi.waitFor(async () => {
    const task = (await listTasks(paths)).at(-1)!
    expect(task.state).toBe(state)
    return task
  }, { timeout: 5000 })
  const chat = (message: string) => runner.chat({ engineId: '', botId: 'bot-1', channel: 'bot-bot-1', message, history: [] })
  await chat(goal)
  expect((await settle('waiting')).question).toBe(question)
  await chat(answer)
  await settle('done')
  await guideSettled(ctx)
  return { jobs, guide: existsSync(join(paths.notes, 'n-work-guide.md')) }
}

it('a question the person asked to be asked is not learned', async () => {
  const t = await answered('Before answering, ask me which color I prefer: Red, Green, or Blue. Use your ask/choice tool so I can pick.', 'Which color do you prefer? Red, Green, or Blue', 'Green')
  expect(t.jobs).toHaveLength(0)
  expect(t.guide).toBe(false)
})

it('a Korean ask-me instruction is not learned', async () => {
  const t = await answered('답하기 전에 빨강, 초록, 파랑 중 어떤 색이 좋은지 나한테 물어봐줘', 'Which color do you prefer?', '초록')
  expect(t.jobs).toHaveLength(0)
  expect(t.guide).toBe(false)
})

it('an ordinary clarifying question is still learned', async () => {
  const t = await answered('Send the weekly report to the team', 'Which recipients need approval?', 'External recipients')
  expect(t.jobs).toHaveLength(1)
  expect(t.jobs[0]!.prompt).toContain('External recipients')
  expect(t.guide).toBe(true)
})
