import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { AgentTool, Engine, ToolSessionJob } from 'core'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'
import * as lane from '../src/main/fast-lane.js'
import { answer, openWorld } from '../src/main/answer.js'

test('a replacement said mid-work reaches the running turn as the person said it, and the draft for the new subject is posted as written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c9a-swap-'))
  try {
    const prompts: string[] = []
    const drafts = ['리스본은 지금 맑고 17도예요.', '포르투는 지금 구름 많고 15도예요. [포르투갈 기상청](https://www.ipma.pt/pt/)']
    const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), runTools: async (job: ToolSessionJob) => { prompts.push(job.prompt); return { answer: drafts[prompts.length - 1]! } } } as unknown as Engine
    const search: AgentTool = { name: 'search_web', description: 'searches the web', argsSchema: { type: 'object' }, run: async () => 'results for "x"\n1. x' }
    const waiting = ['아 리스본 말고 포르투로 봐 줄래']
    const { result } = await answer(await openWorld(dir, engine), '리스본 지금 날씨 좀 볼래', { tools: [search], takeSteer: () => waiting.splice(0) })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('아 리스본 말고 포르투로 봐 줄래')
    expect(result?.answer).toBe(drafts[1])
  } finally { await rm(dir, { recursive: true, force: true }) }
  expect(Object.keys(lane).filter(key => typeof (lane as Record<string, unknown>)[key] === 'function').sort()).toEqual(['asideShape', 'laneFirstLine', 'quickQuestion', 'shortAsk', 'shortQuestion', 'teamAsk'])
  expect(COLLEAGUE_CORE_RULE).toContain('When they change the ask while you work, the first sentence names the new subject.')
})
