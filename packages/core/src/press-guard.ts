
export interface PressTarget {
  download?: boolean
  role?: string
  submits: boolean
  words: string
  shows?: boolean
  posts?: boolean
  navigates?: boolean
}

const COMMIT_WORDS =
  /\b(buy|purchase|pay|checkout|place (the )?order|order now|delete|remove|discard|publish|post|send|submit|withdraw|transfer|unsubscribe)\b/i
const KOREAN_COMMIT = /결제|구매|주문|삭제|제거|발송|전송|보내기|제출|게시(?!판|물|글)|송금|해지|탈퇴/
const KOREAN_ACTION = /(?:결제|구매|주문|삭제|제거|발송|전송|보내기|제출|게시|송금|해지|탈퇴)(?:하기|합니다)?[.!]?$/

const LINK_DESTINATIONS = /^(purchase orders|sent mail|submitted requests|주문 목록|구매 요청)$/i

const PASSAGE_WORDS =
  /\b(sign ?in|log ?in|continue|next|proceed|go|open|view|show|search|find|filter|refresh|reload|more|back|close|ok|okay|select|choose|browse|expand|collapse|details?)\b|로그인|계속|다음|이동|열기|보기|조회|검색|찾기|필터|새로고침|더보기|뒤로|닫기|확인|선택|상세/i

const KEEP_WORDS =
  /\b(save|apply|register|request|approve|confirm|book|reserve|create|add|new|edit|update|change)\b|저장|등록|신청|승인|확정|예약|작성|수정|추가|신규|변경|반려|상신/i
export const pressKeeps = (words: string): boolean => KEEP_WORDS.test(words)

export function pressCommits(target: PressTarget): boolean {
  if (target.download) return true
  if (target.shows) return false
  const label = target.words.trim()
  const korean = target.role === undefined ? KOREAN_COMMIT.test(label)
    : target.role === 'button' && label.length <= 40 && KOREAN_ACTION.test(label)
  const commits = COMMIT_WORDS.test(label) || korean
  if (PASSAGE_WORDS.test(target.words) && !commits) return false
  if (target.navigates && !target.submits && LINK_DESTINATIONS.test(target.words.trim())) return false
  if (commits) return true
  return target.submits && target.posts !== false
}
