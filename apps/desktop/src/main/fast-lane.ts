// grokbar: a web lookup, or a "have bots research this" ask, ran on the work model with ~72 tools and a 38k-char prompt:
// 13 s to plan a hire, 8 s to merge, 30-45 s for one weather or stock lookup. Such a turn runs on the smart tier with a
// menu small enough to be put in the prompt whole (PRELOADED_TOOLS_MAX). The match is a closed word list, no model:
// a miss costs only speed (the normal lead has every tool), so anything that hints at other work stays out.
export const LANE_TOOLS = new Set(['hire_members', 'review_member', 'team_status', 'search_web', 'read_pages', 'open_page', 'read_open_page', 'search_memory', 'read_note', 'search_chats', 'ask_person'])

const TEAM = /봇\s*(을|들|들을)?\s*(\d+\s*(개|명|마리)\s*)?(을|를)?\s*(생성|만들|써서|시켜|돌려|붙여)|팀원|(각각|따로|나눠서?)\s*(따로\s*)?(조사|검색|알아)|\b(bots?|agents?|team members?)\b[^.\n]*\b(research|look up|find|investigate)|\b(research|look up|investigate)\b[^.\n]*\bseparately\b/i
const LOOKUP = /날씨|기온|강수|비\s*(와|오|올)|눈\s*(와|오|올)|미세\s*먼지|주가|주식|시세|환율|뉴스|가격|출시일|조사|리서치|검색|찾아\s*(줘|봐)|알아\s*봐|\b(weather|forecast|stock price|share price|exchange rate|news|research|look up|search for)\b/i
// Anything the small menu cannot do: files, documents, apps, sending, making, schedules, memory, and work given to a named person (the company tools).
const OTHER_WORK = /한테|에게|뽑아|채용|내보내|해고|승진|맡겨|파일|폴더|문서|워드|엑셀|피피티|슬라이드|보고서|메일|보내|전송|올려|게시|저장|만들|작성|써\s*줘|예약|결제|구매|주문|삭제|지워|열어|실행|앱|화면|캘린더|일정|매일|매주|매달|노트|메모|기억|클릭|로그인|다운로드|\.(md|csv|pdf|docx?|xlsx?|pptx?|txt|hwp)\b|\b(files?|folders?|documents?|word|excel|ppt|powerpoint|slides?|report|e-?mail|send|post|save|create|make|write|draft|book|buy|order|delete|open|run|app|screen|calendar|schedule|every (day|week|month)|notes?|remember|click|sign in|download)\b/i
const ASK_MAX = 400

export const LANE_NOTE = 'Fast lookup turn: you have reading tools and a hidden team, nothing else. For one lookup, go to the most direct source (search_web, or read_pages on a page that holds the answer), use at most two tool calls, then answer in a few lines with the address it came from. When the person asks for bots, members or separate research of several items: one hire_members call with one lookup member per item, each brief one line (what to find, for where and when) and each deliverable one line, no notes. Then answer once: one lead-in line, one table when there are several items, the source address in every row; no extra sections, no offers, nothing they did not ask for.'
export const SMALL_TALK_NOTE = 'This message is small talk: reply in one or two short sentences, with no tools.'

// plain: an ordinary first turn by the person on a Claude brain - no attachment, no resumed or scheduled work, no check turn.
export function fastLane(message: string, plain: boolean): boolean {
  const text = message.trim()
  if (!plain || !text || [...text].length > ASK_MAX || text.startsWith('/')) return false
  const team = TEAM.exec(text)
  // The words that ask for the team ("봇 3개 만들어서") are not other work.
  if (OTHER_WORK.test(team ? text.replace(team[0], ' ') : text)) return false
  return !!team || LOOKUP.test(text)
}
