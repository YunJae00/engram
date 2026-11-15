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

// Words said while a turn worked are saved where they were said. Each is shown after the answer of
// the turn running then, so every reply sits under its own question. With `late`, the ones whose
// answer is not in the list are handed back there instead of being put at the end.
export function askOrder<T extends ChatTurnDto>(list: T[], late?: T[]): T[] {
  const out: T[] = [], held: T[] = []
  for (const turn of list) {
    if (turn.role === 'user' && turn.aside) { held.push(turn); continue }
    if (turn.role === 'user') out.push(...held.splice(0))
    out.push(turn)
    if (isAnswer(turn) && held.length) out.push(held.shift()!)
  }
  if (!late) return [...out, ...held]
  late.push(...held)
  return out
}
