import { afterEach, expect, test } from 'vitest'
import { recordFacts } from '../src/bot-memory.js'
import { createBot, loadBots } from '../src/bots.js'
import { setReportLog, staffTool, teamSummary, TEAM_MEMORY } from '../src/company-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

afterEach(() => setReportLog(() => undefined))

test('the week summary is the one model call\'s text as written: the prompt names every doer and who left, nothing checks or repairs the draft, and the outcome is logged', async () => {
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
  const bots = await loadBots(paths), lines: string[] = [], calls: string[] = []
  setReportLog(line => lines.push(line))
  const draft = '이번 주엔 이안이 베란다 텃밭 모종을 조사했어요. 보람이 텃밭 안내 문구 2개를 썼어요.'
  const write = async (prompt: string): Promise<string> => { calls.push(prompt); return draft }
  expect(await teamSummary(paths, { bots, message: '이번 주에 팀이 해 놓은 일 알려줘', now: new Date(2026, 10, 18, 10), write })).toBe(draft)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('Call everyone by the name in "who", also someone no longer on the team')
  expect(calls[0]).toContain('"left":true')
  expect(lines).toEqual(['summary=written jobs=3 left=2'])
})
