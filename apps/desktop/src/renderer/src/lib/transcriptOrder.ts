import type { ChatTurnDto } from '../../../shared/types.js'
import { doneText } from './answerTail.js'

const isAnswer = (turn: ChatTurnDto): boolean => turn.role === 'assistant' && !turn.progress
const isProgress = (turn: ChatTurnDto): boolean => turn.role === 'assistant' && !!turn.progress

// What the live thread showed for each saved turn; null where it showed nothing.
export function shownTexts(list: ChatTurnDto[]): (string | null)[] {
  const out: (string | null)[] = list.map(turn => turn.text)
  let from = 0
  for (let j = 0; j < list.length; j++) {
    const answer = list[j]!
    if (!isAnswer(answer)) continue
    let first = -1
    for (let i = from; i < j && first < 0; i++) if (isProgress(list[i]!) && answer.text.startsWith(list[i]!.text)) first = i
    const steered = first >= 0 && list.slice(first + 1, j).some(turn => turn.role === 'user')
    if (steered) {
      let prefix = ''
      for (let i = first; i < j; i++) if (isProgress(list[i]!) && answer.text.startsWith(prefix + list[i]!.text)) prefix += list[i]!.text
      out[j] = doneText(answer.text, prefix, '')
    } else {
      for (let i = from; i < j; i++) if (isProgress(list[i]!) && answer.text.startsWith(list[i]!.text)) out[i] = null
    }
    from = j + 1
  }
  return out
}

// Words said while a turn worked are saved where they were said, and the running turn takes them in: they stay there, above the
// one answer that covers them (grokbar c3 T1: the added city was drawn under the four-city table). Only words that were
// answered by a turn of their own are shown after the running turn's answer, so that reply sits under its own question: when N
// answers follow in the same stretch, the last N-1 of the words said there each got one. The host's one-line reply moves with its words.
// With `late`, the list is one page of a longer thread: words whose stretch runs off its end are handed back there, to be
// placed after the answer on the newer side as before.
export function askOrder<T extends ChatTurnDto>(list: T[], late?: T[]): T[] {
  const out: T[] = [], held: T[][] = []
  const said = (turn: T): boolean => turn.role === 'user' && !!turn.aside
  const ownTurn = (at: number): boolean => {
    let answers = 0, after = 0, i = at + 1
    for (; i < list.length && !(list[i]!.role === 'user' && !list[i]!.aside); i++) { if (isAnswer(list[i]!)) answers++; else if (said(list[i]!)) after++ }
    // shortcut: at a page boundary the answers are on the other page, so the words are placed the old way (after the next answer); count across pages if that shows.
    return after < answers - 1 || !!late && i === list.length && answers === 0
  }
  for (const [at, turn] of list.entries()) {
    if (said(turn) && ownTurn(at)) { held.push([turn]); continue }
    // The reply line under words that were held goes with them.
    if (turn.role === 'assistant' && turn.aside && held.length && at > 0 && held.at(-1)!.at(-1) === list[at - 1]) { held.at(-1)!.push(turn); continue }
    if (turn.role === 'user' && !turn.aside) out.push(...held.splice(0).flat())
    // c4 T2: a first line is saved when a tool call freezes it, which can be after words said mid-work and their reply were saved; it was
    // on screen before them (its time is when it was first shown), so it goes back above them: ask, first line, the change, the reply, the answer.
    let to = out.length
    if (isProgress(turn) && !turn.aside && turn.at) while (to > 0 && out[to - 1]!.aside && (out[to - 1]!.at ?? '') > turn.at) to--
    if (to < out.length) { out.splice(to, 0, turn); continue }
    out.push(turn)
    if (isAnswer(turn) && held.length) out.push(...held.shift()!)
  }
  if (!late) return [...out, ...held.flat()]
  late.push(...held.flat())
  return out
}
