import { expect, test } from 'vitest'
import { withoutRepeats } from '../src/search-template.js'

const row = (title: string, date = '11월 17일', i = Math.random()) => ({ title, url: `https://news${i}.example/a`, snippet: '', date })

test('stack-10 (c10a run H6): one funding round told by three outlets is one news item, whatever words describe it', () => {
  const query = '국내 AI 스타트업 투자 뉴스'
  expect(withoutRepeats([row('메디인테크, 338억 규모 시리즈C 투자 유치…AI 로봇내시경 기술 고도화', undefined, 1), row('메디인테크, 338억 규모 시리즈C 투자 유치로 AI 로봇 수술 고도화에 속도', undefined, 2), row('메디인테크, 338억 규모 시리즈C 투자 유치하며 수술로봇 시장 공략', undefined, 3)], query)).toHaveLength(1)
  expect(withoutRepeats([row('뷰노랩, 120억 시리즈B…의료영상 판독 확대', '11월 3일', 1), row('뷰노랩 120억 투자 유치, 병원 공급 늘린다', '11월 3일', 2)], query)).toHaveLength(1)
  expect(withoutRepeats([row('카카오벤처스, 뤼튼 100억 투자', undefined, 1), row('카카오벤처스, 업스테이지 200억 투자', undefined, 2)], query)).toHaveLength(2)
  expect(withoutRepeats([row('리벨리온, 300억 시리즈A 유치', '3월 2일', 1), row('리벨리온, 300억 추가 유치', '11월 2일', 2)], query)).toHaveLength(2)
})
