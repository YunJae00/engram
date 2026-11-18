import type { ThreadLang } from './threadLang.js'
import { KO_STOP } from './threadLangKo.js'

const STARTS = [...KO_STOP.starts, 'Stopped.', 'Stopped here. ']
const ENDED = [KO_STOP.ended, 'The turn ended without an answer.']
const cutShort = (text: string): boolean => { const said = text.trim(); return STARTS.some(start => said.startsWith(start)) || ENDED.some(line => said.includes(line)) }

export function withRetry(text: string, lang: ThreadLang | undefined, replies: string[]): string[] {
  if (!cutShort(text)) return replies
  const retry = lang === 'ko' ? KO_STOP.retry : 'Continue'
  return [retry, ...replies.filter(reply => reply !== retry)].slice(0, 3)
}
