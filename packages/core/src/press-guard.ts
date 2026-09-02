// A press on a page the comet is only reading must never commit anything
// the person would not undo in a moment: money out, a form filed, something
// deleted or published. Everything else - moving through a site, opening a
// menu, running a search, carrying on through a sign-in it did not have to
// type into - is work, and work that stops to ask about every step is worse
// than useless: the person ends up doing it themselves.
//
// So the question is never "could this do something?" but "would this be
// hard to take back?". What the control is, is read off the page; the words
// on it decide only when the shape does not.

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
  // The form it sits in posts. A form that only gets - a search, a filter,
  // a report query - carries nothing away with it.
  posts?: boolean
  // A link, a menu entry, a thing that opens a panel: it moves the person
  // through the site rather than acting on their behalf.
  navigates?: boolean
}

// Words that name something hard to take back. Deliberately narrow: each of
// these spends money, files something, destroys something, or puts it where
// others can see it. Words like "apply" (a filter), "confirm" (a dialog) and
// "save" (a draft, a view) are NOT here - those were what turned reading a
// page into a queue of questions.
const COMMIT_WORDS =
  /\b(buy|purchase|pay|checkout|place (the )?order|order now|delete|remove|discard|publish|post|send|submit|withdraw|transfer)\b|결제|구매|주문|삭제|제거|발송|전송|제출|게시|송금|해지|탈퇴/i

// Words that carry a person through a site. A control saying one of these is
// passage, not commitment, and is pressed without asking even when it happens
// to be a form's own button - a sign-in the comet did not have to type a
// password into is exactly this.
const PASSAGE_WORDS =
  /\b(sign ?in|log ?in|continue|next|proceed|go|open|view|show|search|find|filter|refresh|reload|more|back|close|ok|okay|select|choose|browse|expand|collapse|details?)\b|로그인|계속|다음|이동|열기|보기|조회|검색|찾기|필터|새로고침|더보기|뒤로|닫기|확인|선택|상세/i

export function pressCommits(target: PressTarget): boolean {
  // A control the page itself declares to be a state of the view is read,
  // not action: it is what tabs, toggles, filters and unit pickers are, and
  // refusing those turns reading a page into asking permission to read it.
  if (target.shows) return false
  // Passage first, so a sign-in button inside a login form reads as passage
  // rather than as a submission.
  if (PASSAGE_WORDS.test(target.words) && !COMMIT_WORDS.test(target.words)) return false
  if (COMMIT_WORDS.test(target.words)) return true
  // A link or a menu entry carrying no committing word goes where it says.
  if (target.navigates && !target.submits) return false
  // What is left is an unlabelled button that posts a form: nobody can say
  // what it carries, so the person does.
  return target.submits && target.posts !== false
}
