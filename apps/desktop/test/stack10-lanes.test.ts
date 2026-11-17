import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isCorrection, reshapeAsk, reshapeCandidate } from '../src/main/desk-lane'
import { fastLane } from '../src/main/fast-lane'

const ipc = readFileSync(join(__dirname, '../src/main/ipc.ts'), 'utf8')
const reply = '엔비디아는 지금 182.3달러예요. [네이버 증권](https://finance.naver.com)'

describe('stack-10: the c10c desk paths and the c10a lane paths never share a turn', () => {
  it('the desk folder sort needs a desk kind, which needs no lane; the lane tidy runs only inside the lane block', () => {
    expect(ipc).toMatch(/const kind = !company && !lane && deskLane\(/)
    expect(ipc).toMatch(/const sorted = !handed && kind === 'tidy'/)
    const laneBlock = ipc.slice(ipc.indexOf('if (lane && !result.asked) {'))
    expect(laneBlock.indexOf('result.answer = laneTidy(result.answer)')).toBeGreaterThan(0)
    expect(ipc.split('laneTidy(').length - 1).toBe(1)
    expect(ipc.split('sortByKind(').length - 1).toBe(1)
  })
  it('the fast-tier reshape is never asked for a lookup, a team ask, a handed or company turn, or a desk kind that makes a file', () => {
    const line = /const reshaped = ([^\n]+)/.exec(ipc)![1]!
    for (const gate of ['!company', '!lane', '!handed', '(!kind || short)', '!isCorrection(request.message)']) expect(line).toContain(gate)
  })
  it('a send, a post or a team ask is no reshape even when the voice writes one (wordings not in the harness)', async () => {
    const yes = vi.fn(async () => '엔비디아는 182.3달러예요.')
    for (const message of ['이거 수진이한테 카톡으로 보내줘', '방금 거 팀 채널에 올려줘', '봇 3개 돌려서 도시별로 나눠서 알아봐']) {
      expect(reshapeCandidate(message, reply), message).toBe(false)
      expect(await reshapeAsk(message, reply, yes), message).toBeUndefined()
    }
    expect(yes).not.toHaveBeenCalled()
    expect(await reshapeAsk('방금 거 한 문장으로 줄여봐', reply, yes)).toBe('엔비디아는 182.3달러예요.')
    // A bare word of the old yes/no protocol is no reply.
    expect(await reshapeAsk('방금 거 한 문장으로 줄여봐', reply, async () => 'YES')).toBeUndefined()
  })
  it('"엔비디아 말고 애플" after a lookup is a lane ask or a correction, not a reshape', () => {
    for (const message of ['엔비디아 말고 애플 주가', '테슬라 말고 애플로 알려줘']) expect(fastLane(message, true) || isCorrection(message), message).toBe(true)
  })
})

describe('stack-10 (c10a run L1, "today\'s date missing"): a weather answer keeps its date, said plainly', async () => {
  const { LANE_NOTE, laneTidy } = await import('../src/main/fast-lane')
  it('the date in brackets after a day word moves before it; the note asks for the date, never in brackets', () => {
    expect(laneTidy('오늘(12월 3일, 수)은 눈 오고 -2.0도예요.')).toBe('12월 3일 오늘은 눈 오고 -2도예요.')
    expect(laneTidy('내일(1월 9일)은 맑대요.')).toBe('1월 9일 내일은 맑대요.')
    expect(LANE_NOTE).toContain('opening on the day it is for with its date said plainly, never in brackets')
  })
})
