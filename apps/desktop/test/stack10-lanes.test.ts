import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runComet, type Engine } from 'core'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'
import * as desk from '../src/main/desk-lane'
import { isCorrection } from '../src/main/desk-lane'
import * as lane from '../src/main/fast-lane'
import { fastLane } from '../src/main/fast-lane'

const ipc = readFileSync(join(__dirname, '../src/main/ipc.ts'), 'utf8')
const reply = '엔비디아는 지금 182.3달러예요. [네이버 증권](https://finance.naver.com)'
const posted = async (ask: string, draft: string, quick = vi.fn(async () => ''), options: NonNullable<Parameters<typeof runComet>[2]> = {}) => (await runComet({ engine: { id: 'claude', quick, runTools: async () => ({ answer: draft }) } as unknown as Engine, workdir: '.' as never, tools: [] }, ask, { guided: false, modelHint: 'smart', history: [{ role: 'assistant', text: reply }], ...options })).answer

describe('stack-10: the c10c desk paths and the c10a lane paths never share a turn', () => {
  it('the desk folder sort needs a desk kind, which needs no lane; the lane has no tidy and no shaping step left to run anywhere', () => {
    expect(ipc).toMatch(/const kind = !company && !lane && deskLane\(/)
    expect(ipc).toMatch(/const sorted = !handed && kind === 'tidy'/)
    expect(ipc).not.toMatch(/laneTidy|shapeLane|laneShaped/)
    expect('laneTidy' in lane).toBe(false)
    expect(ipc.split('sortByKind(').length - 1).toBe(1)
  })
  it('no turn is reshaped by a second model: a lookup, a team ask, a handed or company turn and a desk turn all post the one draft, and another form is the model\'s to write', () => {
    expect(ipc).not.toMatch(/const reshaped|reshapeAsk|reshapeCandidate/)
    for (const gone of ['reshapeAsk', 'reshapeCandidate', 'reshapePrompt', 'askedBefore']) expect(gone in desk, gone).toBe(false)
    expect(ipc).toContain('`${result.asked ? askText(result.answer, result.options) : result.answer}${note}`,')
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
  it('"엔비디아 말고 애플" after a lookup is a lane ask or a correction, not a reshape', () => {
    for (const message of ['엔비디아 말고 애플 주가', '테슬라 말고 애플로 알려줘']) expect(fastLane(message, true) || isCorrection(message), message).toBe(true)
  })
})

describe('stack-10 (c10a run L1, "today\'s date missing"): a weather answer keeps its date, said plainly', async () => {
  const { LANE_NOTE } = await import('../src/main/fast-lane')
  it('a date in brackets after a day word is posted as the model wrote it; the note asks for the date, never in brackets, before it writes', async () => {
    for (const draft of ['오늘(12월 3일, 수)은 눈 오고 -2.0도예요.', '내일(1월 9일)은 맑대요.']) expect(await posted('속초 지금 눈 와?', draft, undefined, { lookup: true, maxCalls: 4, attachmentContext: LANE_NOTE })).toBe(draft)
    expect(LANE_NOTE).toContain('opening on the day it is for with its date said plainly, never in brackets')
    expect(COLLEAGUE_CORE_RULE).toContain('a day is said with its date in plain words, never in brackets')
  })
})
