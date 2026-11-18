import { describe, expect, it } from 'vitest'
import { kindChecked, withItems } from '../src/company-tools.js'
import { judgedItems, setJudgeLog } from '../src/item-check.js'

// stack-15. Wordings are not the harness's: 별빛 도서관 개관, 수원 제과점 개업.
describe('c15a r3 #1: a first-hand fact with the very same words as a second-hand one in hand still takes its place', () => {
  it('the official page replaces the blog, word for word the same sentence', async () => {
    const old = { text: '별빛 도서관은 3월 2일 개관해요', url: 'https://blog.example/old', site: '블로그' }
    const fresh = { text: old.text, url: 'https://city.example/official', site: '구청' }
    const more = await kindChecked({ facts: [fresh] }, '별빛 도서관 개관', async () => JSON.stringify({ keep: [1, 2], same: [[1, 2]], secondhand: [1] }), 1000, [old])
    const merged = withItems({ facts: [old] }, more, true)
    expect(merged.facts.map(f => f.url)).toEqual(['https://city.example/official'])
    expect(merged.facts.some(f => 'instead' in f)).toBe(false)
  })
  it('the same words with no first-hand verdict are still that entry found again: nothing is added', () => {
    const old = { text: '별빛 도서관은 3월 2일 개관해요', url: 'https://blog.example/old', site: '블로그' }
    expect(withItems({ facts: [old] }, { facts: [{ ...old, url: 'https://other.example/2' }] }, true).facts).toEqual([old])
  })
})

describe('the item judge reads its verdict inside any words around it (c15a run R3/H6: verdict=none, unjudged rows listed)', () => {
  const items = [{ text: '수원 제과점 A가 11월 3일 개업했어요', link: 'https://news.example/a' }, { text: '제과 업계 매출 통계', link: 'https://stats.example/b' }]
  const verdict = { keep: [1], unsure: [], same: [], lists: [], names: { 1: '제과점 A' }, listing: [2], outside: [], secondhand: [], asked: 2, search: '수원 빵집 새로 문 연 곳' }
  it('a fenced answer with a line before and after it is still the verdict', async () => {
    const said = await judgedItems('수원 제과점 개업 소식 2건', items, async () => `Here is the judgment:\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`\nDone.`, 1000, { tried: [] })
    expect(said?.keep).toEqual([1])
    expect(said?.asked).toBe(2)
    expect(said?.search).toBe('수원 빵집 새로 문 연 곳')
  })
  it('why no verdict came is logged: an answer with no JSON, a failed call, a late one', async () => {
    const lines: string[] = []
    setJudgeLog(line => lines.push(line))
    expect(await judgedItems('수원 제과점 개업 소식 2건', items, async () => '판단하기 어렵습니다', 1000)).toBeUndefined()
    expect(await judgedItems('수원 제과점 개업 소식 2건', items, async () => { throw new Error('busy') }, 1000)).toBeUndefined()
    expect(await judgedItems('수원 제과점 개업 소식 2건', items, () => new Promise<string>(() => undefined), 50)).toBeUndefined()
    setJudgeLog(() => undefined)
    expect(lines.map(line => line.match(/why=(\w+)/)?.[1])).toEqual(['unreadable', 'error', 'late'])
  })
})
