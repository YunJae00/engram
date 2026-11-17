import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { asState, answerAlone } from '../src/main/first-line.js'
import { withoutSameDecisions } from '../src/main/desk-lane.js'

const ipc = readFileSync(fileURLToPath(new URL('../src/main/ipc.ts', import.meta.url)), 'utf8')

// stack-7: c7c's host corrections (a 결정사항 line's owner tail, an opening promise, "-하세요" → "-하고 계세요") were written for a desk
// note and a recall answer. After the merge they sit in the same function as c7a's lookup lane and c7b's team lane: they act on a desk
// answer only, never on a team result, a lookup or a document's content.
it('stack-7: the desk corrections run only for a desk answer: the desk kind exists only outside the team lane and the lookup lane', () => {
  expect(ipc).toContain('const kind = !company && !lane && deskLane(routed, plainAsk) ? deskKind(routed) : undefined')
  expect(ipc).toContain("const short = kind === 'ask' || kind === 'question'")
  for (const line of [
    'if (short && !result.steps.length && !result.asked) result.answer = answerAlone(result.answer)',
    'if (short && !result.asked) result.answer = asState(request.message, result.answer)',
    "if (kind === 'note' && !result.asked) result.answer = withoutSameDecisions(routed, result.answer)",
    "if (kind === 'note' && !result.asked) result.answer = answerAlone(result.answer)",
  ]) expect(ipc).toContain(line)
  // Each is called exactly there and nowhere else in the turn.
  expect(ipc.match(/asState\(/g)).toHaveLength(1)
  expect(ipc.match(/withoutSameDecisions\(/g)).toHaveLength(1)
  expect(ipc.match(/= answerAlone\(/g)).toHaveLength(2)
})

it('stack-7: what the corrections would do to a team result or a lookup answer if they ever reached one stays visible here', () => {
  // A team result of c7b's shape and a lookup answer are not about the person, so asState leaves them even when asked.
  const team = '둘 다 찾아봤어요.\n\n지민: 노션이 AI 회의록을 냈어요. [노션](https://notion.so/a)\n\n서연: 슬랙은 허들 요약을 냈어요. [슬랙](https://slack.com/b)'
  expect(asState('노션, 슬랙 신기능 조사해줘', team)).toBe(team)
  expect(asState('엔비디아 오늘 주가 알려줘', '11월 16일 종가 기준 155.26달러예요.')).toBe('11월 16일 종가 기준 155.26달러예요.')
  // An ask that names no 결정사항 and 할 일 block leaves a team result's lines whole.
  expect(withoutSameDecisions('노션, 슬랙 신기능 조사해줘', team)).toBe(team)
  // The opening-promise rule would take a host line off a team result ("…맡길게요." above content), which is why it is desk-only.
  expect(answerAlone(team)).toBe(team)
})
