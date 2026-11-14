import { describe, expect, it } from 'vitest'
import { appendBotTurn, createTask, listTasks, readBotTranscript, TASK_MAX_TURNS, TASK_TOKEN_BUDGET, updateTask } from 'core'
import { done, setup } from './task-runner-fixture.js'
import { closingMessage, ENDED_LOG, isRestartQuestion, type ClosingReason } from '../src/main/task-closing.js'
import { stoppedText } from '../src/renderer/src/lib/threadLang.js'

const reasons: ClosingReason[] = ['budget', 'turn-limit', 'error', 'empty', 'restart']
const hangul = /[가-힣]/
const since = '2026-11-14T10:00:00.000Z'
const transcript = [
  { role: 'assistant', text: 'Old [old.md](engram-artifact:a/old.md)', at: '2026-11-13T10:00:00.000Z' },
  { role: 'user', text: 'x', at: since },
  { role: 'assistant', text: 'two items checked\nmore', at: '2026-11-14T10:01:00.000Z', progress: true },
  { role: 'assistant', text: 'Saved [report.md](engram-artifact:a/report.md)', at: '2026-11-14T10:02:00.000Z' },
]
const texts = (events: { type: string }[], type: string) => events.filter(e => e.type === type).map(e => (e as { text?: string; message?: string }).text ?? (e as { message?: string }).message ?? '')

describe('closingMessage', () => {
  it.each(reasons.flatMap(r => (['ko', 'en'] as const).map(l => [r, l] as const)))('%s in %s has done, missing and next lines', (reason, lang) => {
    const goal = lang === 'ko' ? '보고서 정리' : 'Tidy the report'
    const lines = closingMessage({ goal, work: 4, trail: [{ tool: 'press', args: {}, observation: 'ok', committed: true }], transcript, since, detail: 'boom' }, reason, lang).split('\n')
    expect(lines).toHaveLength(4)
    const text = lines.join('\n')
    expect(text).toContain('report.md')
    expect(text).not.toContain('old.md')
    if (lang === 'ko') {
      for (const line of lines) expect(line).toMatch(hangul)
      expect(lines[0]).toMatch(/^한 일: 4단계 진행, 확정한 작업 1개/)
      expect(lines.at(-1)).toMatch(/^다음: /)
    } else {
      for (const line of lines) expect(line).not.toMatch(hangul)
      expect(lines[0]).toMatch(/^Done so far: 4 steps, 1 confirmed action/)
      expect(lines.at(-1)).toMatch(/^Next: /)
    }
  })

  it.each(reasons.flatMap(r => (['ko', 'en'] as const).map(l => [r, l] as const)))('%s in %s with nothing logged still gives a next step', (reason, lang) => {
    const lines = closingMessage({ goal: lang === 'ko' ? '정리' : 'Tidy', transcript: [] }, reason, lang).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(lang === 'ko' ? '한 일: 아직 확인된 결과는 없어요.' : 'Done so far: nothing confirmed yet.')
    expect(lines[2]!.length).toBeGreaterThan(10)
    if (reason === 'empty') expect(lines[1]).toBe(lang === 'ko' ? '답을 마치지 못하고 끝났어요.' : ENDED_LOG)
  })

  it('shows the first line of an error and cuts long ones and long file lists', () => {
    const one = closingMessage({ goal: '정리', transcript: [], detail: 'Provider unavailable\nstack at x' }, 'error', 'ko')
    expect(one).toContain('(Provider unavailable)')
    expect(one).not.toContain('stack')
    const long = closingMessage({ goal: 'g'.repeat(200), transcript: [], detail: 'e'.repeat(500) }, 'error', 'en')
    expect(long.length).toBeLessThan(400)
    const files = closingMessage({ goal: 'Tidy', transcript: [], result: ['a', 'b', 'c', 'd', 'e'].map(n => `[${n}.md](engram-artifact:${n})`).join(' ') }, 'budget', 'en')
    expect(files).toContain('saved a.md, b.md, c.md and 2 more')
  })
})

describe('task runner end paths', () => {
  const budgetRun = async (asked: string) => {
    const t = await setup(async () => ({ ...done('partial'), tokensUsed: TASK_TOKEN_BUDGET, budgetExhausted: true }))
    await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: asked, at: new Date().toISOString() })
    await t.chat(asked)
    await t.settle('failed')
    return t
  }

  it('closes a budget stop in a Korean thread with Korean text, once', async () => {
    const t = await budgetRun('긴 작업 해줘')
    const last = texts(t.events, 'chat:done').at(-1)!
    expect(last).toMatch(hangul)
    expect(last).toContain('처리 한도')
    const kinds = t.events.map(e => e.type)
    expect(kinds.lastIndexOf('comet:continue')).toBeLessThan(kinds.lastIndexOf('chat:done'))
    expect(JSON.stringify(t.events)).not.toContain('Stopped at the task')
    const turns = await readBotTranscript(t.paths, 'bot-1')
    expect(turns.at(-1)!.text).toBe(last)
    expect(turns.filter(turn => turn.text.includes('처리 한도'))).toHaveLength(1)
  })

  it('keeps an English thread English', async () => {
    const t = await budgetRun('Long job')
    const last = texts(t.events, 'chat:done').at(-1)!
    expect(last).not.toMatch(hangul)
    expect(last).toContain('processing limit')
  })

  it('closes a turn limit hit before the turn starts', async () => {
    const t = await setup(async () => done('never'))
    const task = await createTask(t.paths, '목록 정리', 'bot-1')
    await updateTask(t.paths, task.id, x => { x.state = 'waiting'; x.question = 'Which?'; x.turns = TASK_MAX_TURNS })
    await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: '이걸로 해줘', at: new Date().toISOString() })
    await t.chat('이걸로 해줘')
    expect(t.sent).toHaveLength(0)
    expect((await listTasks(t.paths)).at(-1)!.state).toBe('failed')
    expect(texts(t.events, 'chat:done').at(-1)).toContain('진행 횟수 한도')
  })

  it('replaces a raw engine error with a Korean closing', async () => {
    const t = await setup(async () => { throw new Error('Provider unavailable') })
    await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: '정리해줘', at: new Date().toISOString() })
    await expect(t.chat('정리해줘')).rejects.toThrow('Provider unavailable')
    const errors = texts(t.events, 'chat:error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(hangul)
    expect(errors[0]).toContain('Provider unavailable')
    expect((await listTasks(t.paths)).at(-1)!.state).toBe('failed')
  })

  it('asks the restart question in the thread language and does not learn from it', async () => {
    const t = await setup(async () => done('계속했어요'))
    const task = await createTask(t.paths, '보고서 정리', 'bot-1')
    await updateTask(t.paths, task.id, x => { x.state = 'running' })
    await t.runner.resume()
    const question = (await listTasks(t.paths)).at(-1)!.question!
    expect(question).toMatch(hangul)
    expect(isRestartQuestion(question)).toBe(true)
    await t.chat('확인했어요, 계속')
    expect(t.learned).toEqual([])
    expect(t.sent).toHaveLength(1)
    expect(isRestartQuestion('The app restarted during this task. Check any external changes before asking me to continue.')).toBe(true)
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
