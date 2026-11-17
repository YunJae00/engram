import { expect, test } from 'vitest'
import { createBot } from '../src/bots.js'
import { employeeWriteBack, teamRecord } from '../src/company-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// stack-12 replay C10 (C5's job recorded as "4개 찾았어요" with a listing page among the four): the record counts single items only,
// the same rule as the team answer's count. Wordings are not the harness's.
test('the record line counts single items, never a listing page or the full-list line', async () => {
  const paths = await initVault(await tmpVaultRoot('stack12-record'))
  const bot = await createBot(paths, { name: '나래' })
  const data = { facts: [
    { text: '12월 3일 광주에서 AI 밋업이 열려요.', url: 'https://g.example/1', site: 'g', name: '광주 AI 밋업' },
    { text: '12월 9일 광주에서 해커톤이 열려요.', url: 'https://g.example/2', site: 'g' },
    { text: '광주 IT 행사 모음이에요.', url: 'https://g.example/list', site: 'g', listing: true as const },
    { text: '', url: 'https://g.example/all', site: 'g', rest: true as const },
  ] }
  await employeeWriteBack(paths, { botId: bot.id, brief: '다음 달 광주 IT 행사 일정', result: 'x', title: '다음 달 광주 IT 행사 일정', data }, new Date('2026-11-18T10:00:00+09:00'))
  expect((await teamRecord(paths)).facts.map(f => f.text)).toEqual(['다음 달 광주 IT 행사 일정 → 광주 AI 밋업 등 2개 찾았어요 (나래, 2026-11-18)'])
})
