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
  // The control only changes what is shown: a tab, a switch, a radio, an
  // entry in a list. Pressing one sends nothing and buys nothing, whatever
  // the words on it happen to be - "billing period" is not a payment.
  shows?: boolean
}

const COMMIT_WORDS =
  /\b(submit|save|send|post|publish|order|buy|purchase|pay|checkout|delete|remove|apply|register|sign ?up|subscribe|confirm)\b|제출|저장|전송|등록|주문|구매|결제|삭제|신청|가입|발송|확정|승인/i

export function pressCommits(target: PressTarget): boolean {
  if (target.submits) return true
  // A control the page itself declares to be a state of the view is read,
  // not action: it is what tabs, toggles, filters and unit pickers are, and
  // refusing those turns reading a page into asking permission to read it.
  if (target.shows) return false
  return COMMIT_WORDS.test(target.words)
}
