import { describe, expect, it } from 'vitest'
import { pressCommits } from '../src/press-guard.js'

describe('a press that would commit something is told apart from one that only moves', () => {
  it('refuses by shape: a submit control, or a form button with no other type', () => {
    expect(pressCommits({ submits: true, words: 'Next' })).toBe(true)
    expect(pressCommits({ submits: false, words: 'Next' })).toBe(false)
  })

  it('refuses by the words on it, in either language', () => {
    for (const words of ['Submit', 'Save changes', 'Buy now', 'Place order', 'Delete', 'Sign up', '제출', '저장', '주문하기', '결제', '삭제', '신청']) {
      expect(pressCommits({ submits: false, words })).toBe(true)
    }
  })

  it('lets a tab, a day, a page or a plain OK through', () => {
    for (const words of ['Notices', 'Previous week', '24', '이전 페이지', '다음', '확인', 'International flights', 'Q2 report']) {
      expect(pressCommits({ submits: false, words })).toBe(false)
    }
  })
})
