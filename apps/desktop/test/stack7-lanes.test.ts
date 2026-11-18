import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { answerAlone } from '../src/main/first-line.js'
import { shareReady, withoutSameDecisions } from '../src/main/desk-lane.js'

const ipc = readFileSync(fileURLToPath(new URL('../src/main/ipc.ts', import.meta.url)), 'utf8')

it('stack-7: the desk corrections run only for a desk answer: the desk kind exists only outside the team lane and the lookup lane (c11b: asState went)', () => {
  expect(ipc).toContain('const kind = !company && !lane && deskLane(routed, plainAsk) ? deskKind(routed) : undefined')
  expect(ipc).toContain("const short = kind === 'ask' || kind === 'question'")
  for (const line of [
    'if (short && !result.steps.length && !result.asked) result.answer = answerAlone(result.answer)',
    "if (kind === 'note' && !result.asked) result.answer = withoutSameDecisions(meant, result.answer)",
    "if (kind === 'note' && !result.asked) result.answer = answerAlone(result.answer)",
  ]) expect(ipc).toContain(line)
  expect(ipc).not.toContain('asState(')
  expect(ipc.match(/withoutSameDecisions\(/g)).toHaveLength(1)
  expect(ipc.match(/= answerAlone\(/g)).toHaveLength(2)
})

it('stack-7: what the corrections would do to a team result or a lookup answer if they ever reached one stays visible here (c11b)', () => {
  const team = '둘 다 찾아봤어요.\n\n지민: 노션이 AI 회의록을 냈어요. [노션](https://notion.so/a)\n\n서연: 슬랙은 허들 요약을 냈어요. [슬랙](https://slack.com/b)'
  expect(answerAlone('11월 16일 종가 기준 155.26달러예요.')).toBe('11월 16일 종가 기준 155.26달러예요.')
  expect(withoutSameDecisions('노션, 슬랙 신기능 조사해줘', team)).toBe(team)
  expect(answerAlone(team)).toBe(team)
})

it('stack-7: a share-ready summary has one lead: the model\'s own past-tense lead stands, and the host\'s is added only when there is none', () => {
  const ask = 'fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘'
  const body = '## 결정사항\n\n- 온보딩 화면은 B안으로 가요.\n\n## 할 일\n\n- 한서연 — 시안 확정, 기한: 11월 20일\n\n## 미결\n\n- 결제 모듈 후보는 다음 회의에서 정해요.'
  const own = '결정사항과 할 일, 미결 위주로 짧게 정리했어요.'
  expect(shareReady(ask, `회의록 내용부터 다듬을게요.\n\n${own}\n\n${body}`)).toBe(`${own}\n\n${body}`)
  expect(shareReady(ask, `팀에 공유하기 좋게 정리할게요.\n\n${body}`)).toBe(`결정사항이랑 할 일 위주로 짧게 정리했어요.\n\n${body}`)
  expect(shareReady(ask, body)).toBe(`결정사항이랑 할 일 위주로 짧게 정리했어요.\n\n${body}`)
  expect(shareReady(ask, `${own}\n\n${body}`)).toBe(`${own}\n\n${body}`)
})
