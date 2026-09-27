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
    // A menu entry named for what it leads to is passage, even when the
    // word on it is one an action would also use.
    for (const words of ['Reports', '설정', 'Sign up page', '신청 내역']) {
      expect(pressCommits({ submits: false, words, navigates: true })).toBe(false)
    }
    // A link named for a place is passage even when the name holds an action word.
    for (const words of ['Purchase orders', 'Sent mail', 'Submitted requests', '주문 목록', '구매 요청']) {
      expect(pressCommits({ submits: false, words, navigates: true })).toBe(false)
    }
    // A link that says it deletes, pays or cancels is still that act.
    for (const words of ['Delete this row', 'Pay now', 'Unsubscribe', 'Send message', 'Publish now', 'Submit request', 'Buy', '결제하기', '회원 탈퇴', '전송', '게시', '제출', '구매']) {
      expect(pressCommits({ submits: false, words, navigates: true })).toBe(true)
    }
    // The same place words on a form's own button still ask.
    expect(pressCommits({ submits: true, words: 'Submit request', posts: true })).toBe(true)
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
