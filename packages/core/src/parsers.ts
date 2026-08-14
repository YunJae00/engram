// Chat-paste parsers: Slack and KakaoTalk pastes keep speaker
// and time; anything unrecognized passes through untouched.

export interface ChatMessage {
  speaker: string
  time: string
  text: string
}

export interface ParsedCapture {
  kind: 'slack' | 'kakao' | 'plain'
  messages: ChatMessage[]
}

const KAKAO_PC = /^(?<date>\d{4}년 \d{1,2}월 \d{1,2}일) (?<time>(?:오전|오후) \d{1,2}:\d{2}), (?<speaker>[^:]+) : (?<text>.*)$/
const KAKAO_MOBILE = /^\[(?<speaker>[^\]]+)\] \[(?<time>(?:오전|오후) ?\d{1,2}:\d{2})\] (?<text>.*)$/
// Slack paste: a header line "Name  10:24 AM" (or "Name [10:24]") followed by
// message lines until the next header.
const SLACK_HEADER = /^(?<speaker>\S.{0,60}?)\s{1,4}\[?(?<time>\d{1,2}:\d{2}(?:\s?[AP]M)?)\]?$/

function parseKakao(lines: string[]): ChatMessage[] | null {
  const messages: ChatMessage[] = []
  let matched = 0
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const pc = KAKAO_PC.exec(line)
    const mobile = pc ? null : KAKAO_MOBILE.exec(line)
    const hit = pc ?? mobile
    if (hit?.groups) {
      matched++
      const date = pc?.groups?.['date']
      messages.push({
        speaker: hit.groups['speaker']!.trim(),
        time: date ? `${date} ${hit.groups['time']}` : hit.groups['time']!,
        text: hit.groups['text'] ?? '',
      })
    } else if (messages.length > 0) {
      // continuation line of the previous message
      messages[messages.length - 1]!.text += '\n' + line
    }
  }
  return matched >= 2 ? messages : null
}

function parseSlack(lines: string[]): ChatMessage[] | null {
  const messages: ChatMessage[] = []
  let headers = 0
  for (const line of lines) {
    const header = SLACK_HEADER.exec(line.trimEnd())
    if (header?.groups) {
      headers++
      messages.push({ speaker: header.groups['speaker']!.trim(), time: header.groups['time']!, text: '' })
    } else if (messages.length > 0 && line.trim().length > 0) {
      const current = messages[messages.length - 1]!
      current.text = current.text.length > 0 ? current.text + '\n' + line.trim() : line.trim()
    }
  }
  // Require ≥2 headers and at least one body so prose does not false-positive.
  return headers >= 2 && messages.some((m) => m.text.length > 0) ? messages : null
}

export function parseChatPaste(text: string): ParsedCapture {
  const lines = text.split(/\r?\n/)
  const kakao = parseKakao(lines)
  if (kakao) return { kind: 'kakao', messages: kakao }
  const slack = parseSlack(lines)
  if (slack) return { kind: 'slack', messages: slack }
  return { kind: 'plain', messages: [] }
}

// Markdown that keeps the original speaker/time structure for J1.
export function chatToMarkdown(parsed: ParsedCapture, raw: string): string {
  if (parsed.kind === 'plain') return raw
  const label = parsed.kind === 'slack' ? 'Slack' : 'KakaoTalk'
  const body = parsed.messages
    .map((m) => `- **${m.speaker}** (${m.time}): ${m.text.replace(/\n/g, '\n  ')}`)
    .join('\n')
  return `# ${label} conversation\n\n${body}\n`
}

// Entry point used by every capture path: chat pastes get structured,
// everything else stays as-is.
export function normalizeCapture(text: string): string {
  return chatToMarkdown(parseChatPaste(text), text)
}
