import { shortAsk, shortQuestion } from './fast-lane.js'

// grokbar B7 (stack1-f4f6844c): everyday desk work ran on the work model with 73 tools and a 40k-char prompt, and most of the time was
// that model's rounds: M1-M3 (remember, correct, recall) 9-12 s for one keep_in_mind call or none, F2 9 s with no call, F1 41 s (20 s
// before its first call), D5 35 s for one edit, D3 87 s (54 s writing five slides). The same turn on the smart tier keeps every tool
// and its shell. The match is a closed word list, no model: a miss costs only speed, so anything not plainly one of these stays out.
const KEEP = /기억\s*해|잊지\s*마|외워\s*(둬|줘)|(말고|아니고|아니라)\s*\S+(이야|야|이에요|예요|입니다)|\bremember (that|this|my|i)\b/i
const FILES = /폴더|파일|디렉터리|\bfolders?\b|\bfiles?\b/i
const TIDY = /정리|분류|옮겨|나눠|\btidy\b|\borgani[sz]e\b|\bsort\b/i
const DECK = /ppt|피피티|파워포인트|슬라이드|발표\s*자료|powerpoint|\bslides?\b|\bdeck\b/i
const DECK_WORK = /만들|작성|바꿔|고쳐|수정|변경|추가|\b(make|create|build|change|rename|fix|add)\b/i
// grokbar H3: "fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘" took 31.6 s on the work model, which wrote a file for a chat-sized answer.
// A summary, tidy-up or extraction of a named note or text file, with no document to make and nowhere to send it, is desk work answered in the chat.
const NOTE = /\.(md|txt)(?![a-z])|회의록|메모|\bnotes?\b|\bminutes\b/i
const NOTE_WORK = /정리|요약|뽑아|추려|다듬|\b(summari[sz]e|tidy|clean up|extract|list)\b/i
const NOTE_OUT = /워드|엑셀|피피티|ppt|슬라이드|보고서|파일로|문서로|pdf|만들|작성|저장|보내|전송|올려|게시|메일|슬랙|노션|카톡|한테|에게|\b(send|post|e-?mail|slack|notion)\b|\b(word|excel|powerpoint|slides?|report|file|make|create|save)\b/i
const ASK_MAX = 200

export const DESK_NOTE = 'Do exactly what was asked in as few steps as it takes: when the request itself names what to work on, start on it without searching memory or notes first. Something to remember or to correct is ONE keep_in_mind call (a correction replaces the old fact) and a one-line reply that says what is now true, never that it was saved. After moving or sorting files, the answer is one or two sentences with how many files of each kind were moved ("정리했어요. PDF 6개, 이미지 4개, 문서 3개예요."): no table and no list of file names unless they ask. After changing a document, say in one line what changed. A summary, tidy-up or extraction of a note or text file is answered in the chat itself, with only what is in that file: make a file only when they asked for one.'

// grokbar cycle 3 (M1, M2, F1, D3): above the preload limit (engine-claude-session.ts PRELOADED_TOOLS_MAX = 16) tool shapes are deferred and the
// model spends a round looking each one up: M1 took three rounds for one 15 ms keep_in_mind call, F1 and D3 ~6 s per look. A desk turn whose
// kind is plain gets only the tools that kind uses, few enough to be given whole. The model's own file tools and shell are apart from this menu.
export type DeskKind = 'keep' | 'tidy' | 'deck' | 'note' | 'ask' | 'question'
const MEMORY_TOOLS = ['keep_in_mind', 'search_memory', 'read_note', 'search_chats']
export const DESK_TOOLS: Partial<Record<DeskKind, ReadonlySet<string>>> = {
  keep: new Set(MEMORY_TOOLS),
  tidy: new Set(['find_files', 'file_move', 'file_read']),
  // Every tool the document rows used (D2-D5: word_write, ppt_build, file_read, file_read_package, file_edit_package, file_create_workbook,
  // file_read_workbook) plus search and memory. open_page is left out: it alone turns on the browser rules and their receipt tool.
  deck: new Set(['ppt_build', 'word_write', 'file_read', 'file_read_package', 'file_edit_package', 'file_read_workbook', 'file_create_workbook', 'file_create_copy', 'find_files', 'render_file', 'search_web', 'read_pages', 'search_memory', 'read_note', 'search_chats', 'ask_person']),
  note: new Set([...MEMORY_TOOLS, 'file_read', 'find_files', 'ask_person']),
  // A short ask is answered from the conversation and what the model knows: no browser.
  ask: new Set([...MEMORY_TOOLS, 'file_read', 'find_files', 'ask_person']),
}
export function deskKind(message: string): DeskKind | undefined {
  const text = message.trim()
  if (!text || [...text].length > ASK_MAX || text.includes('\n') || text.startsWith('/')) return undefined
  return KEEP.test(text) ? 'keep' : FILES.test(text) && TIDY.test(text) ? 'tidy' : DECK.test(text) && DECK_WORK.test(text) ? 'deck' : NOTE.test(text) && NOTE_WORK.test(text) && !NOTE_OUT.test(text) ? 'note' : shortAsk(text) ? 'ask' : shortQuestion(text) ? 'question' : undefined
}

// plain: an ordinary first turn by the person on a Claude brain (ipc.ts plainAsk): nothing attached, resumed, scheduled or re-checked.
export const deskLane = (message: string, plain: boolean): boolean => plain && !!deskKind(message)

// "아 그거 말고 11월 걸로", "그냥 애플로 바꿔": a correction of the ask before it. Its own few words say nothing about the kind of work, so the
// turn takes the route of the ask it corrects. A corrected fact ("아 지민호 말고 민호야") is a remember turn of its own.
const CORRECTION = /^(아[,\s]+|아니[,\s]+|음[,\s]+)*(그거|그건|그게|이거|저거|방금\s*(거|것)|아까\s*(거|것)|그냥)?\s*\S{0,12}\s*(말고|대신)(\s|$)|^(아[,\s]+|아니[,\s]+)*그냥\s.{0,24}(으로|로)\s*(바꿔|해)/
export const isCorrection = (message: string): boolean => { const text = message.trim(); return [...text].length <= 60 && !text.includes('\n') && !KEEP.test(text) && CORRECTION.test(text) }
export const routeAsk = (message: string, earlier: readonly { role: string; text: string }[]): string =>
  isCorrection(message) ? [...earlier].reverse().find(turn => turn.role === 'user')?.text ?? message : message

// grokbar H1: "다음 주 목요일에 부모님 모시고 제주도 가. 아빠가 무릎이 안 좋으셔서 많이 걷는 건 힘들어" asked for nothing and became a 47-step
// web research task. A message that only tells something gets one warm line from the quick voice (first-line.ts toldPrompt) and no work.
// shortcut: a closed list of asking and ordering words; the quick voice still says NONE for anything that wants work, and a statement this
// misses is only answered by the normal turn. Widen the lists when a plain statement is seen starting work.
const ASKING = /[?？]|줘|주세요|줄래|주라|드려|해\s*봐|알려|찾아|정리|만들|작성|어때|어떨까|할까|될까|을까|일까|까요|나요|부탁|추천|검색|조사|요약|번역|보내|바꿔|고쳐|수정|써\s*봐|맡겨|맡기|시켜|넘겨|뽑아|내보내|취소|멈춰|그만|기억|잊지|외워|말고|아니고|아니라|빼|지워|삭제|다시|계속|시작|진행|넣어|추가|열어|닫아|실행|저장|예약|결제|주문|구매|보여|읽어|확인|매주|매일|매달|\b(please|can you|could you|would you|will you|what|how|why|when|where|who|which|find|make|write|send|show|tell|give|check|stop|remember|add|remove|delete|open|run|schedule|every)\b/i
const THINGS = /폴더|파일|문서|\.(md|csv|pdf|docx?|xlsx?|pptx?|txt|hwp)(?![a-z])|[\w-]+\/[\w.-]+|https?:\/\/|한테|에게|담당|팀원|봇/i
const TOLD_MIN = 15
// lastReply: what the assistant said last; a message that answers its question belongs to the turn that asked.
export function onlyTells(message: string, lastReply = ''): boolean {
  const text = message.trim(), size = [...text].length
  if (size < TOLD_MIN || size > ASK_MAX || text.includes('\n') || text.startsWith('/')) return false
  if (/[?？]\s*(```[^]*)?$/.test(lastReply.trim())) return false
  if (KEEP.test(text)) return false
  return /[가-힣]/.test(text) ? !ASKING.test(text) && !THINGS.test(text) : /^(i|i'm|i am|i've|we|we're|my|our)\b/i.test(text) && !ASKING.test(text) && !THINGS.test(text)
}
export const TOLD_NOTE = 'The person is telling you something here, not asking for work: reply with one or two short, warm sentences that show you took in what matters, and use no tools. Keep it in mind for later asks.'
