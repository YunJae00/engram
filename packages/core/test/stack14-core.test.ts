import { afterEach, expect, test } from 'vitest'
import { recordFacts } from '../src/bot-memory.js'
import { createBot, loadBots } from '../src/bots.js'
import { setReportLog, staffTool, teamSummary, TEAM_MEMORY } from '../src/company-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// stack-14 targeted results, C10 in the c14b run (cause W): the summary said "도윤과 지우가 경쟁사 신기능을 조사했는데", leaving out 서연 who
// did that job too, and named 서연's later job without saying she had left; the check's own words only caught a left teammate "named as
// if still on it", and nothing logged what it said. Wording not the harness's: 제주 숙소 후보 조사, teammates 다온 (removed) / 시우.
afterEach(() => setReportLog(() => undefined))
const CHECK = 'Judge meaning only', REDO = 'You fix a message'

test('the week summary check covers a shared job told without one of its doers and a left teammate named only for past work; its outcome is logged', async () => {
  const paths = await initVault(await tmpVaultRoot('stack14-summary'), { git: false })
  await createBot(paths, { name: '엔그램' })
  const run = (args: Record<string, unknown>) => staffTool(paths, () => undefined).run(args, { task: '' })
  await run({ add: [{ name: '다온', role: '리서치 담당' }, { name: '시우', role: '리서치 담당' }] })
  await recordFacts(paths, TEAM_MEMORY, [
    '이번 주 제주 숙소 후보 조사 → 애월 숙소 두 곳을 찾았어요 (다온, 2026-11-16)',
    '이번 주 제주 숙소 후보 조사 → 서귀포 숙소 한 곳을 찾았어요 (시우, 2026-11-16)',
    '이번 주 숙소 소개 문구 쓰기 → 문구 2개를 썼어요 (다온, 2026-11-17)',
  ], new Date('2026-11-17T03:00:00.000Z'))
  await run({ remove: ['다온'] })
  const bots = await loadBots(paths), lines: string[] = [], calls: string[] = []
  setReportLog(line => lines.push(line))
  const draft = '이번 주엔 시우가 제주 숙소 후보를 조사했어요. 다온이 숙소 소개 문구 2개를 썼어요.'
  const fixed = '이번 주엔 다온이랑 시우가 제주 숙소 후보를 조사했어요. 다온이 숙소 소개 문구 2개도 썼는데, 지금은 팀에 없어요.'
  const verdicts = [JSON.stringify({ problems: [{ kind: 'contradicts', quote: '시우가 제주 숙소 후보를 조사했어요', why: '다온도 했어요' }, { kind: 'unsaid', quote: '다온이 숙소 소개 문구 2개를 썼어요', why: '떠난 걸 말하지 않았어요' }] }), JSON.stringify({ problems: [] })]
  // c18b: the repair is scoped: the two quoted sentences are replaced, nothing else is written again.
  const repair = JSON.stringify({ replace: { 1: '이번 주엔 다온이랑 시우가 제주 숙소 후보를 조사했어요.', 2: '다온이 숙소 소개 문구 2개도 썼는데, 지금은 팀에 없어요.' } })
  const write = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? verdicts.shift()! : prompt.includes(REDO) ? repair : draft }
  expect(await teamSummary(paths, { bots, message: '이번 주 팀이 한 일 알려줘', now: new Date(2026, 10, 18, 10), write })).toBe(fixed)
  const check = calls.find(prompt => prompt.includes(CHECK))!
  // The two meaning classes the check is asked for, read against the record's own flags (who did which job, who left).
  expect(check).toContain('leaves out someone the data says did it too')
  expect(check).toContain('naming their past work is not saying it')
  expect(lines).toEqual(['summary=repaired:contradicts+unsaid jobs=3 left=2'])
})
