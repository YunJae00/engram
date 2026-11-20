import { expect, test } from 'vitest'
import { createBot } from '../src/bots.js'
import { employeeWriteBack, teamRecord, handBacks } from '../src/company-tools.js'
import { datedText, type TeamMember } from '../src/delegated-tasks.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'
import { settleMember } from '../src/team-hire-tools.js'

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

test('a decimal never stands for a day, and a year-only date already in the text is not shown again', () => {
  expect(datedText({ text: '가입자가 3.4배로 늘었어요.', date: '3월 4일' })).toBe('가입자가 3.4배로 늘었어요 (3월 4일).')
  expect(datedText({ text: '참가비가 1.5만 원이에요.', date: '1월 5일' })).toBe('참가비가 1.5만 원이에요 (1월 5일).')
  expect(datedText({ text: '2027년 로봇 박람회가 열려요.', date: '2027' })).toBe('2027년 로봇 박람회가 열려요.')
  expect(datedText({ text: '로봇 박람회가 열려요.', date: '2027' })).toBe('로봇 박람회가 열려요 (2027).')
  expect(datedText({ text: '3.4. 개막해요.', date: '3월 4일' })).toBe('3.4. 개막해요.')
  expect(datedText({ text: '3.4(수) 개막해요.', date: '3월 4일' })).toBe('3.4(수) 개막해요.')
})

test('a teammate who hands back a listing page beside its own items is passed on as written: no label, no item added or taken away', () => {
  const answer = ['1. 12월 7일 강변 자전거 정비 교실이 열려요. https://bikeshop.example/class/7',
    '2. 12월 14일 초보 라이딩 모임이 있어요. https://bikeshop.example/ride/14',
    '그 밖의 모임은 이 목록에 모여 있어요. https://bikeshop.example/events'].join('\n')
  const sources = ['https://bikeshop.example/class/7', 'https://bikeshop.example/ride/14', 'https://bikeshop.example/events']
  const m: TeamMember = { id: 'r1', parentId: null, depth: 1, role: '단비', brief: '다음 달 자전거 가게 행사 일정', state: 'working', sessionKey: 'r1', hiredAt: '2026-11-18T00:00:00Z', lookup: true }
  settleMember(m, { answer, sources }, '2026-11-18T00:00:09Z', true)
  expect(m.result).toBe(answer)
  expect(m.data).toBeUndefined()
  const [report] = (JSON.parse(handBacks([m])) as { reports: { result: string; sources?: string[] }[] }).reports
  expect(report).toMatchObject({ result: answer, sources })
})
