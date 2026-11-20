import { expect, test } from 'vitest'
import { runComet } from '../src/agent-session.js'
import { COLLEAGUE_CORE_RULE, FILE_JOB_RULE } from '../src/agent-voice.js'
import { MockEngine } from '../src/engine/mock.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'

const WORKDIR = 'C:/tmp' as EngineCwd
async function session(ask: string, draft: string): Promise<{ answer: string; jobs: ToolSessionJob[] }> {
  const jobs: ToolSessionJob[] = []
  const engine = {
    id: 'mock', detect: async () => ({ installed: true, loggedIn: true }),
    run: async function* () { yield { type: 'result', text: '' } },
    runTools: async (job: ToolSessionJob): Promise<ToolSessionResult> => { jobs.push(job); return { answer: draft } },
  } as unknown as Engine
  const result = await runComet({ engine, workdir: WORKDIR, tools: [] }, ask, { guided: false })
  return { answer: result.answer, jobs }
}
async function stepped(ask: string, draft: string): Promise<{ answer: string; prompts: string[] }> {
  const prompts: string[] = []
  const engine = new MockEngine({ default: prompt => { prompts.push(prompt); return JSON.stringify({ tool: 'answer', args: { text: draft } }) } }, { gapMs: 0 })
  const result = await runComet({ engine, workdir: WORKDIR, tools: [] }, ask, { guided: false })
  return { answer: result.answer, prompts }
}
const fences = (text: string): number => text.split('\n').filter(line => /^\s*```/.test(line)).length
const REPLIES = ['```replies', '두부도 넣어줘', '양 좀 줄여줘', '```'].join('\n')
const LIST = ['장보기 목록만 뽑았어요.', '', '- 대파 한 단', '- 계란 한 판', '- 우유 1L', '', REPLIES].join('\n')

test('H2 reproduction: a draft that ends in a chip block is delivered with the block whole, so no orphan fence can appear', async () => {
  const { answer, jobs } = await session('장보기 목록만 뽑아줘', LIST)
  expect(answer).toBe(LIST)
  expect(fences(answer) % 2).toBe(0)
  expect(answer.endsWith(REPLIES)).toBe(true)
  expect(jobs).toHaveLength(1)
})

test('item 1: the opener, a chip line and the closer come back byte-identical from one model call; the list above them does too on the step path', async () => {
  const one = await session('장보기 목록만 뽑아줘', LIST)
  for (const line of ['```replies', '두부도 넣어줘', '```']) expect(one.answer.split('\n')).toContain(line)
  expect(one.answer).toBe(LIST)
  expect(one.jobs).toHaveLength(1)
  const plain = LIST.slice(0, LIST.indexOf(REPLIES)).trimEnd()
  const two = await stepped('장보기 목록만 뽑아줘', plain)
  expect(two.answer).toBe(plain)
  expect(two.prompts).toHaveLength(1)
  expect(two.prompts[0]).toMatch(/^JOB: COMET-STEP/m)
})

test('item 1: a real code block between prose lines is delivered with the prose around it, the closing question included', async () => {
  const draft = ['엑셀에서 이렇게 쓰면 돼요.', '```', '=SUMIF(A:A, "택배", B:B)', '```', '원하시면 다른 함수도 알려 드릴까요?', '합계 칸은 B열 아래에 두세요.'].join('\n')
  const { answer, jobs } = await session('택배비만 더하는 수식 알려줘', draft)
  expect(answer).toBe(draft)
  expect(jobs).toHaveLength(1)
  expect(FILE_JOB_RULE).toContain('Give no offer after a correction, a simple fact, small talk or a short ask.')
  expect(jobs[0]!.system).toContain(FILE_JOB_RULE)
})

test('item 2 (register): a plain-form sentence is delivered as the model wrote it; the -요 form is asked for in the prompt, not made by the host', async () => {
  const draft = '다음 주에 정한다.'
  const { answer, jobs } = await session('등산 동호회 회의 메모 정리해줘', draft)
  expect(answer).toBe(draft)
  expect(jobs).toHaveLength(1)
  expect(jobs[0]!.system).toContain('Register: in Korean keep the polite-casual -요 form through the whole reply ("확인했어요", "바꿔 둘게요"); never switch to -습니다 or to 반말')
})

test('item 2 (register): no repair runs, so no new sentence can be written into the draft and no line of it is taken out', async () => {
  const draft = '- 회비는 2만 원이에요.\n- 엠티는 11월 말에 가요.\n- 장소는 가평으로 확정됐다고 했어요.'
  const one = await session('등산 동호회 공지 요약해줘', draft), two = await stepped('등산 동호회 공지 요약해줘', draft)
  expect(one.answer).toBe(draft)
  expect(two.answer).toBe(draft)
  expect(one.answer.split('\n')).toHaveLength(3)
  expect(one.jobs).toHaveLength(1)
  expect(two.prompts).toHaveLength(1)
})

test('a one-line draft in plain form is delivered unchanged with no second reading, whichever line it is', async () => {
  for (const draft of ['회비는 만 원이다.', '집합 시간은 아침 7시였다.', '회비는 만 원이에요.']) {
    const { answer, jobs } = await session('등산 동호회 알림 문장 하나만', draft)
    expect(answer, draft).toBe(draft)
    expect(jobs, draft).toHaveLength(1)
    expect(jobs[0]!.system).toContain(COLLEAGUE_CORE_RULE)
  }
})

test('a code block\'s blank lines, and the blank lines before it, reach the person as they were', async () => {
  const CODE = ['```python', 'import csv', '', '', '', 'print(total)', '```'].join('\n')
  const draft = ['합계를 내는 코드예요.', '', '', '', CODE, '', '돌리면 합계가 나와요. 결과는 바로 보인다.'].join('\n')
  const one = await session('합계 코드 줘', draft)
  expect(one.answer).toBe(draft)
  expect(one.jobs).toHaveLength(1)
  expect(one.answer).toContain(CODE)
  expect(one.answer.startsWith('합계를 내는 코드예요.\n\n\n\n```python')).toBe(true)
  expect(COLLEAGUE_CORE_RULE).toContain('an empty line cuts the reply into a separate chat bubble')
})
