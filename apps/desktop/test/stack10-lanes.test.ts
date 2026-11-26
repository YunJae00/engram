import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runComet, type Engine } from 'core'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'

const ipc = readFileSync(join(__dirname, '../src/main/ipc.ts'), 'utf8')
const reply = '엔비디아는 지금 182.3달러예요. [네이버 증권](https://finance.naver.com)'
const posted = async (ask: string, draft: string, quick = vi.fn(async () => ''), options: NonNullable<Parameters<typeof runComet>[2]> = {}) => (await runComet({ engine: { id: 'claude', quick, runTools: async () => ({ answer: draft }) } as unknown as Engine, workdir: '.' as never, tools: [] }, ask, { guided: false, modelHint: 'smart', history: [{ role: 'assistant', text: reply }], ...options })).answer

describe('stack-10: the c10c desk paths and the c10a lane paths never share a turn', () => {
  it('no host folder sort is left in the turn, and the lane has no tidy and no shaping step left to run anywhere', () => {
    expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).not.toMatch(/hostable|plainAsk|sortByKind/)
    expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).not.toMatch(/deskKind|deskLane|kind === 'tidy'/)
    expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
    expect(existsSync(new URL('../src/main/fast-lane.ts', import.meta.url))).toBe(false)
    expect(ipc).not.toContain('sortByKind(')
  })
  it('no turn is reshaped by a second model: a lookup, a team ask, a handed or company turn and a desk turn all post the one draft, and another form is the model\'s to write', () => {
    expect(ipc).not.toMatch(/const reshaped|reshapeCandidate/)
    expect(existsSync(new URL('../src/main/desk-lane.ts', import.meta.url))).toBe(false)
    expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
    expect(ipc).toContain('result.asked ? askText(result.answer, result.options) : result.answer,')
    expect(COLLEAGUE_CORE_RULE).toContain('When they ask for your last reply in another form (shorter, as a table, another tone or language), write that reply again in the asked form with every fact and every constraint of the original ask kept, and nothing about what you changed.')
  })
  it('a send, a post, a team ask or a shorter-form ask is answered by the one draft as written, and the quick voice is never asked to rewrite it (wordings not in the harness)', async () => {
    const yes = vi.fn(async () => JSON.stringify({ form: 'shorter', was: '엔비디아는 지금 182.3달러예요.', reply: '엔비디아는 182.3달러예요.' }))
    for (const message of ['이거 수진이한테 카톡으로 보내줘', '방금 거 팀 채널에 올려줘', '봇 3개 돌려서 도시별로 나눠서 알아봐']) {
      const draft = `${message.slice(0, 6)} 건은 바로 해둘게요.`
      expect(await posted(message, draft, yes), message).toBe(draft)
    }
    expect(await posted('방금 답 절반 길이로 다시 써봐', '엔비디아는 182.3달러예요.', yes)).toBe('엔비디아는 182.3달러예요.')
    expect(await posted('방금 답 절반 길이로 다시 써봐', 'YES', yes)).toBe('YES')
    expect(yes).not.toHaveBeenCalled()
  })
})

describe('stack-10 (c10a run L1, "today\'s date missing"): a weather answer keeps its date, said plainly', () => {
  it('a date in brackets after a day word is posted as the model wrote it; the shared rule asks for the date, never in brackets, before it writes', async () => {
    for (const draft of ['오늘(12월 3일, 수)은 눈 오고 -2.0도예요.', '내일(1월 9일)은 맑대요.']) expect(await posted('강릉 경포대 쪽 지금 바람 세게 불어?', draft, undefined, { maxCalls: 4 })).toBe(draft)
    expect(COLLEAGUE_CORE_RULE).toContain('a day is said with its date in plain words, never in brackets')
  })
})
