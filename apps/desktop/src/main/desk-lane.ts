import { shortQuestion } from './fast-lane.js'

// grokbar B7 (stack1-f4f6844c): everyday desk work ran on the work model with 73 tools and a 40k-char prompt, and most of the time was
// that model's rounds: M1-M3 (remember, correct, recall) 9-12 s for one keep_in_mind call or none, F2 9 s with no call, F1 41 s (20 s
// before its first call), D5 35 s for one edit, D3 87 s (54 s writing five slides). The same turn on the smart tier keeps every tool
// and its shell. The match is a closed word list, no model: a miss costs only speed, so anything not plainly one of these stays out.
const KEEP = /기억\s*해|잊지\s*마|외워\s*(둬|줘)|(말고|아니고|아니라)\s*\S+(이야|야|이에요|예요|입니다)|\bremember (that|this|my|i)\b/i
const FILES = /폴더|파일|디렉터리|\bfolders?\b|\bfiles?\b/i
const TIDY = /정리|분류|옮겨|나눠|\btidy\b|\borgani[sz]e\b|\bsort\b/i
const DECK = /ppt|피피티|파워포인트|슬라이드|발표\s*자료|powerpoint|\bslides?\b|\bdeck\b/i
const DECK_WORK = /만들|작성|바꿔|고쳐|수정|변경|추가|\b(make|create|build|change|rename|fix|add)\b/i
const ASK_MAX = 200

export const DESK_NOTE = 'Do exactly what was asked in as few steps as it takes: when the request itself names what to work on, start on it without searching memory or notes first. Something to remember or to correct is ONE keep_in_mind call (a correction replaces the old fact) and a one-line reply that says what is now true, never that it was saved. After moving or sorting files, end with a short two-column table of what went where: each folder with how many files it got, and their names. After changing a document, say in one line what changed.'

// plain: an ordinary first turn by the person on a Claude brain (ipc.ts plainAsk): nothing attached, resumed, scheduled or re-checked.
export function deskLane(message: string, plain: boolean): boolean {
  const text = message.trim()
  if (!plain || !text || [...text].length > ASK_MAX || text.includes('\n') || text.startsWith('/')) return false
  return shortQuestion(text) || KEEP.test(text) || (FILES.test(text) && TIDY.test(text)) || (DECK.test(text) && DECK_WORK.test(text))
}
