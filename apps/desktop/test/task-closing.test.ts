import { describe, expect, it } from 'vitest'
import { appendBotTurn, createTask, listTasks, readBotTranscript, TASK_MAX_TURNS, TASK_TOKEN_BUDGET, updateTask } from 'core'
import { done, setup } from './task-runner-fixture.js'
import { noticeText } from '../src/main/task-notify.js'
import { stoppedText } from '../src/renderer/src/lib/threadLang.js'

const texts = (events: { type: string }[], type: string) => events.filter(e => e.type === type).map(e => (e as { text?: string; message?: string }).text ?? (e as { message?: string }).message ?? '')
const assistant = async (paths: Parameters<typeof readBotTranscript>[0]) => (await readBotTranscript(paths, 'bot-1')).filter(turn => turn.role === 'assistant')

describe('a task that ends without the model answering', () => {
  it('stores no host closing after a budget stop whose answer was already delivered, and shows no limit line after it', async () => {
    const t = await setup(async () => ({ ...done('창고 재고는 세 곳 중 두 곳까지 확인했어요.'), tokensUsed: TASK_TOKEN_BUDGET, budgetExhausted: true }))
    await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: '창고 세 곳 재고 맞춰봐', at: new Date().toISOString() })
    await t.chat('창고 세 곳 재고 맞춰봐')
    await t.settle('failed')
    expect(texts(t.events, 'chat:error')).toEqual([])
    expect(t.delivered).toEqual(['창고 재고는 세 곳 중 두 곳까지 확인했어요.'])
    expect(await assistant(t.paths)).toEqual([])
  })

  it('shows the usage line in the thread language when the task is over its limit before a model runs, and stores nothing', async () => {
    for (const [asked, line] of [['이 순서로 진행해', 'AI 사용 한도에 도달했어요'], ['Go in this order', 'AI usage limit reached']] as const) {
      const t = await setup(async () => done('never'))
      const task = await createTask(t.paths, asked, 'bot-1')
      await updateTask(t.paths, task.id, x => { x.state = 'waiting'; x.question = 'Which?'; x.turns = TASK_MAX_TURNS })
      await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: asked, at: new Date().toISOString() })
      await t.chat(asked)
      expect(t.sent).toHaveLength(0)
      expect((await listTasks(t.paths)).at(-1)!.state).toBe('failed')
      expect(texts(t.events, 'chat:error')).toEqual([expect.stringContaining(line)])
      expect(texts(t.events, 'chat:done')).toEqual([])
      expect(await assistant(t.paths)).toEqual([])
    }
  })

  it('shows an engine error as the error, once, with no host closing around it', async () => {
    const t = await setup(async () => { throw new Error('Provider unavailable') })
    await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: '견적서 비교해줘', at: new Date().toISOString() })
    await expect(t.chat('견적서 비교해줘')).rejects.toThrow('Provider unavailable')
    expect(texts(t.events, 'chat:error')).toEqual(['Provider unavailable'])
    expect(await assistant(t.paths)).toEqual([])
    expect((await listTasks(t.paths)).at(-1)!.state).toBe('failed')
  })

  it('shows the usage line, never an empty bubble, when a turn ends with no text at all', async () => {
    const t = await setup(async () => done(''))
    await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: '출장비 영수증 합쳐줘', at: new Date().toISOString() })
    await t.chat('출장비 영수증 합쳐줘')
    await t.settle('failed')
    expect(texts(t.events, 'chat:error')).toEqual([expect.stringContaining('AI 사용 한도에 도달했어요')])
    expect(texts(t.events, 'chat:done')).toEqual([])
    expect(await assistant(t.paths)).toEqual([])
  })

  it('shows the error raised before the task exists as it is', async () => {
    const t = await setup(async () => done('never'))
    const task = await createTask(t.paths, '다른 작업', 'bot-1')
    await updateTask(t.paths, task.id, x => { x.state = 'running' })
    await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: '회의실 예약 바꿔줘', at: new Date().toISOString() })
    await expect(t.chat('회의실 예약 바꿔줘')).rejects.toThrow('still working')
    expect(texts(t.events, 'chat:error')).toEqual([expect.stringContaining('still working')])
    expect(await assistant(t.paths)).toEqual([])
  })

  it('after a restart the task waits with no host question, and the next message carries it on without being learned', async () => {
    const t = await setup(async () => done('이어서 마쳤어요'))
    const task = await createTask(t.paths, '분기 실적표 정리', 'bot-1')
    await updateTask(t.paths, task.id, x => { x.state = 'running' })
    await t.runner.resume()
    const waiting = (await listTasks(t.paths)).at(-1)!
    expect(waiting.state).toBe('waiting')
    expect(waiting.question).toBeUndefined()
    expect(await assistant(t.paths)).toEqual([])
    await t.chat('응 마저 해')
    expect(t.learned).toEqual([])
    expect(t.sent).toHaveLength(1)
    expect((await listTasks(t.paths)).find(one => one.id === task.id)!.state).toBe('done')
  })

  it('a provider error the thread already shows ends the task with nothing more from the host', async () => {
    const t = await setup(async () => ({ answer: '', asked: false, unfinished: true, steps: 0, errored: 'API Error: 400 does not support this model' }))
    await t.chat('회의록 정리해줘')
    const task = await t.settle('failed')
    expect(task.log.at(-1)!.line).toBe('Failed: API Error: 400 does not support this model')
    expect(texts(t.events, 'chat:done')).toEqual([])
    expect(await readBotTranscript(t.paths, 'bot-1')).toEqual([])
  })

  it('picks the notice language from the latest person message', () => {
    expect(noticeText({ state: 'done', goal: 'Prepare the report', approvals: [] }, [{ role: 'user', text: '보고서 정리해줘' }])[0]).toBe('Engram: 다 했어요')
    expect(noticeText({ state: 'done', goal: '보고서 정리', approvals: [] }, [{ role: 'user', text: '보고서' }, { role: 'user', text: 'Now in English' }])[0]).toBe('Engram: Done')
    expect(noticeText({ state: 'failed', goal: '보고서 정리', approvals: [] })[0]).toBe('Engram: 멈췄어요')
  })
})

describe('stoppedText', () => {
  it('names the last milestone of the turn the person stopped', () => {
    expect(stoppedText([{ role: 'user', text: '정리해줘' }])).toBe('멈췄어요.')
    expect(stoppedText([{ role: 'user', text: '정리해줘' }, { role: 'assistant', text: '두 항목 확인했어요\n더', progress: true }])).toBe('여기까지 했어요: 두 항목 확인했어요')
    expect(stoppedText([{ role: 'user', text: '정리해줘' }], '페이지 읽는 중')).toBe('여기까지 했어요: 페이지 읽는 중')
    expect(stoppedText([{ role: 'user', text: 'Tidy' }, { role: 'assistant', text: 'Read two items', progress: true }])).toBe('Stopped here. Done so far: Read two items')
    expect(stoppedText([{ role: 'assistant', text: 'Earlier', progress: true }, { role: 'user', text: 'Tidy' }])).toBe('Stopped.')
  })
})

