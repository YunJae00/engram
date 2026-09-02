import { describe, expect, it } from 'vitest'
import { pressCommits } from '../src/press-guard.js'

describe('a press that would be hard to take back is told apart from one that only moves', () => {
  it('asks about money, filing, destruction and publication, in either language', () => {
    for (const words of ['Submit', 'Buy now', 'Place order', 'Delete', 'Send', 'Publish', '제출', '주문하기', '결제', '삭제', '발송']) {
      expect(pressCommits({ submits: false, words })).toBe(true)
    }
  })

  // The rule that made the app ask about everything: a form button is not by
  // itself a commitment. A search form, a filter, a sign-in - all are buttons
  // in forms, and none of them is hard to take back.
  it('carries the person through a sign-in it did not have to type a password into', () => {
    expect(pressCommits({ submits: true, words: 'Sign in', posts: true })).toBe(false)
    expect(pressCommits({ submits: true, words: '로그인', posts: true })).toBe(false)
    expect(pressCommits({ submits: true, words: 'Continue', posts: true })).toBe(false)
    expect(pressCommits({ submits: true, words: '다음', posts: true })).toBe(false)
  })

  it('runs a search or a filter without asking', () => {
    expect(pressCommits({ submits: true, words: 'Search', posts: false })).toBe(false)
    expect(pressCommits({ submits: true, words: '조회', posts: false })).toBe(false)
    // Even unlabelled: a form that only gets carries nothing away.
    expect(pressCommits({ submits: true, words: '', posts: false })).toBe(false)
  })

  it('still asks about an unlabelled button that posts - nobody can say what it carries', () => {
    expect(pressCommits({ submits: true, words: '', posts: true })).toBe(true)
  })

  it('goes where a link or a menu entry says it goes', () => {
    for (const words of ['휴가/휴직 신청', 'Time Off', 'Expenses', 'Apply for leave']) {
      expect(pressCommits({ submits: false, words, navigates: true })).toBe(false)
    }
    // A link that says it deletes is still a deletion.
    expect(pressCommits({ submits: false, words: 'Delete this row', navigates: true })).toBe(true)
  })

  it('lets a control that only changes what is shown through, whatever its words say', () => {
    // A billing period, a unit picker, a filter: pressing one sends nothing.
    for (const words of ['월간 결제', 'Pay yearly', '주문 내역 보기']) {
      expect(pressCommits({ submits: false, words, shows: true })).toBe(false)
      expect(pressCommits({ submits: false, words })).toBe(true)
    }
  })

  it('lets a tab, a day, a page or a plain OK through', () => {
    for (const words of ['Notices', 'Previous week', '24', '이전 페이지', '다음', '확인', 'International flights', 'Q2 report']) {
      expect(pressCommits({ submits: false, words })).toBe(false)
    }
  })
})
