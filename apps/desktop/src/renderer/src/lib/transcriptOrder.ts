import type { ChatTurnDto } from '../../../shared/types.js'
import { doneText } from './answerTail.js'
import { readsKorean, threadLang } from './threadLang.js'

const isAnswer = (turn: ChatTurnDto): boolean => turn.role === 'assistant' && !turn.progress
const isProgress = (turn: ChatTurnDto): boolean => turn.role === 'assistant' && !!turn.progress

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
  for (let i = 0; i < list.length; i++) if (out[i] !== null && isProgress(list[i]!) && list[i]!.text.trim() && threadLang(list.slice(0, i)) === 'ko' && !readsKorean(list[i]!.text)) out[i] = null
  return out
}

export function askOrder<T extends ChatTurnDto>(list: T[], late?: T[]): T[] {
  const out: T[] = [], held: T[][] = []
  const said = (turn: T): boolean => turn.role === 'user' && !!turn.aside
  const ownTurn = (at: number): boolean => {
    let answers = 0, after = 0, i = at + 1
    for (; i < list.length && !(list[i]!.role === 'user' && !list[i]!.aside); i++) { if (isAnswer(list[i]!)) answers++; else if (said(list[i]!)) after++ }
    return after < answers - 1 || !!late && i === list.length && answers === 0
  }
  for (const [at, turn] of list.entries()) {
    if (said(turn) && ownTurn(at)) { held.push([turn]); continue }
    if (turn.role === 'assistant' && turn.aside && held.length && at > 0 && held.at(-1)!.at(-1) === list[at - 1]) { held.at(-1)!.push(turn); continue }
    if (turn.role === 'user' && !turn.aside) out.push(...held.splice(0).flat())
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
