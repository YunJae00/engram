import { expect, test } from 'vitest'
import { createBot } from '../src/bots.js'
import { employeeWriteBack, teamRecord, withItems } from '../src/company-tools.js'
import { datedText } from '../src/delegated-tasks.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

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

test('an extra round that gives the listing page back, or only facts judged a listing, leaves the page labeled and adds no item', () => {
  const page = 'https://club.example.kr/runs'
  const data = { facts: [{ text: '러닝 모임 여러 개가 올라와 있어요.', url: page, site: 'c', listing: true as const }] }
  expect(withItems(data, { facts: [{ text: '러닝 모임 세 개가 있어요.', url: page, site: 'c' }] })).toEqual(data)
  expect(withItems(data, { facts: [{ text: '다른 모임 목록이에요.', url: 'https://club.example.kr/other', site: 'c', listing: true }] })).toEqual(data)
  const one = withItems(data, { facts: [{ text: '12월 7일 수성못 러닝이 있어요.', url: 'https://club.example.kr/runs/7', site: 'c' }] })
  expect(one.facts.map(f => [f.url, f.rest ?? false])).toEqual([['https://club.example.kr/runs/7', false], [page, true]])
  const judged = withItems(data, { facts: [{ text: '12월 14일 앞산 야간 러닝이 있어요.', url: page, site: 'c', date: '12월 14일' }, { text: '다른 모임 목록이에요.', url: page, site: 'c', listing: true }] }, true)
  expect(judged.facts.map(f => [f.text, f.rest ?? false])).toEqual([['12월 14일 앞산 야간 러닝이 있어요.', false], ['러닝 모임 여러 개가 올라와 있어요.', true]])
})
