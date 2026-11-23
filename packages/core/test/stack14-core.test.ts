import { expect, test } from 'vitest'
import { runToolSession } from '../src/agent-session.js'
import { recordFacts } from '../src/bot-memory.js'
import { createBot, loadBots } from '../src/bots.js'
import { companyNote, staffTool, takesCompanyLane, TEAM_MEMORY } from '../src/company-tools.js'
import { MockEngine } from '../src/engine/mock.js'
import type { EngineCwd, ToolSessionResult } from '../src/engine/types.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

class Typist extends MockEngine {
  constructor(private draft: string) { super() }
  runTools(): Promise<ToolSessionResult> { return Promise.resolve({ answer: this.draft }) }
}

test('the week answer is the team lane\'s one model call, as written: its note names every doer, keeps who left off the team, and nothing checks or repairs the draft', async () => {
  const paths = await initVault(await tmpVaultRoot('stack14-summary'), { git: false })
  await createBot(paths, { name: '엔그램' })
  const run = (args: Record<string, unknown>) => staffTool(paths, () => undefined).run(args, { task: '' })
  await run({ add: [{ name: '보람', role: '정원 담당' }, { name: '이안', role: '정원 담당' }] })
  await recordFacts(paths, TEAM_MEMORY, [
    '이번 주 베란다 텃밭 모종 조사 → 방울토마토 모종 두 가지를 찾았어요 (보람, 2026-11-16)',
    '이번 주 베란다 텃밭 모종 조사 → 상추 모종 한 가지를 찾았어요 (이안, 2026-11-16)',
    '이번 주 텃밭 안내 문구 쓰기 → 문구 2개를 썼어요 (보람, 2026-11-17)',
  ], new Date('2026-11-17T03:00:00.000Z'))
  await run({ remove: ['보람'] })
  const bots = await loadBots(paths), ask = '요번 주 팀원들이 한 일 들려줘'
  const draft = '이번 주엔 이안이 베란다 텃밭 모종을 조사했어요. 보람이 텃밭 안내 문구 2개를 썼어요.'
  expect(takesCompanyLane(ask, { staff: ['이안'], gone: ['보람'], chief: true })).toBe(true)
  const [team, record] = (await companyNote(paths, { bots, message: ask, chief: true, now: new Date(2026, 10, 18, 10) })).split('The team\'s record') as [string, string]
  for (const line of ['(보람, 11월 16일)', '(이안, 11월 16일)', '이번 주 텃밭 안내 문구 쓰기 → 문구 2개를 썼어요 (보람, 11월 17일)']) expect(record).toContain(line)
  expect(team).toContain('- 이안 — 정원 담당')
  expect(team).not.toContain('보람')
  expect((await runToolSession({ engine: new Typist(draft), workdir: 'C:/tmp' as EngineCwd, tools: [] }, ask)).answer).toBe(draft)
})
