import { describe, expect, it } from 'vitest'
import { runComet } from '../src/agent-session.js'
import { CHOICE_RULE, COLLEAGUE_CORE_RULE, FILE_JOB_RULE } from '../src/agent-voice.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'
import * as core from '../src/index.js'

const WORKDIR = 'C:/tmp' as EngineCwd
async function turn(ask: string, draft: string): Promise<{ answer: string; jobs: ToolSessionJob[] }> {
  const jobs: ToolSessionJob[] = []
  const engine = {
    id: 'mock', detect: async () => ({ installed: true, loggedIn: true }),
    run: async function* () { yield { type: 'result', text: '' } },
    runTools: async (job: ToolSessionJob): Promise<ToolSessionResult> => { jobs.push(job); return { answer: draft } },
  } as unknown as Engine
  const result = await runComet({ engine, workdir: WORKDIR, tools: [] }, ask, { guided: false })
  return { answer: result.answer, jobs }
}

describe('a draft that leaves out a part the ask names is not judged by the host', () => {
  it('reaches the person as written from one model call, and the rule that nobody completes it is in that call', async () => {
    const ask = '산악회 정기 모임 메모를 정해진 것, 걱정되는 점, 다음 할 일로 나눠줘'
    const draft = '산악회 모임 메모를 두 갈래로 나눴어요.\n\n정해진 것\n- 봄 산행은 4월 둘째 토요일\n\n다음 할 일\n- 버스 대절 견적 받기'
    const { answer, jobs } = await turn(ask, draft)
    expect(answer).toBe(draft)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.prompt).toContain(ask)
    expect(jobs[0]!.system).toContain('Your reply reaches the person exactly as you write it, so write it finished: nobody tidies, checks or completes it after you.')
    expect(jobs[0]!.system).toContain('A part still being worked on, or one that found nothing, is said in one plain sentence in its place, never left out and never shown as finished.')
    for (const gone of ['checkPrompt', 'readProblems', 'checkedWrite', 'repairedWrite']) expect(core).not.toHaveProperty(gone)
  })
})
describe('one closing offer after the work is the writer\'s to keep; a menu before the work is ruled out in the prompt', () => {
  it('the offer line is delivered with the rest, and the rules name the one offer and the menu', async () => {
    const draft = '산행 준비물만 뽑았어요.\n\n- 아이젠\n- 보온병\n- 여벌 양말\n\n원하시면 사람별로 나눠 드릴게요.'
    const { answer, jobs } = await turn('산행 공지에서 준비물만 뽑아줘', draft)
    expect(answer).toBe(draft)
    expect(jobs).toHaveLength(1)
    expect(FILE_JOB_RULE).toContain('ends with exactly ONE short offer line of something new that would really help')
    expect(FILE_JOB_RULE).toContain('An offer is one line, never a menu or a list of offers')
    expect(CHOICE_RULE).toContain('never offer a menu of options or ask how they want it when one reasonable choice exists')
    expect(jobs[0]!.system).toContain(CHOICE_RULE)
  })
})
describe('a shorter form of the last reply keeps the earlier ask\'s facts by rule, not by a second reading', () => {
  it('the shortened draft is delivered as written and the reshaping rule names every fact and constraint', async () => {
    const draft = '산행은 4월 둘째 일요일 새벽 6시, 회비는 3만 원이에요.'
    const { answer, jobs } = await turn('방금 거 한 줄로 줄여줘', draft)
    expect(answer).toBe(draft)
    expect(jobs).toHaveLength(1)
    expect(COLLEAGUE_CORE_RULE).toContain('write that reply again in the asked form with every fact and every constraint of the original ask kept, and nothing about what you changed')
    expect(jobs[0]!.system).toContain(COLLEAGUE_CORE_RULE)
  })
})
