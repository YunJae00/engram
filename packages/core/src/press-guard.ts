// A press on a page the comet is only reading must never commit anything:
// a form going out, an order, a deletion. What a control does is read off
// the page — a submit button is one by shape, and a link or a scripted
// button by the words on it — and a press that would commit is refused, so
// the person is asked instead.

export interface PressTarget {
  // The control submits a form by its own nature: a submit input, or a
  // button inside a form with no other type.
  submits: boolean
  // What the control says, in any language the page uses.
  words: string
}

const COMMIT_WORDS =
  /\b(submit|save|send|post|publish|order|buy|purchase|pay|checkout|delete|remove|apply|register|sign ?up|subscribe|confirm)\b|제출|저장|전송|등록|주문|구매|결제|삭제|신청|가입|발송|확정|승인/i

export function pressCommits(target: PressTarget): boolean {
  return target.submits || COMMIT_WORDS.test(target.words)
}
