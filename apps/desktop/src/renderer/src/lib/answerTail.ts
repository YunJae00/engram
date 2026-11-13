import { withoutReplies } from '../../../../../../packages/core/src/agent-history.js'

const OPENER = '```replies'
const REPLIES_OPEN = /^[ \t]*```[ \t]*replies[ \t]*$/im

// A last line that may still grow into the replies opener is not text yet.
function held(text: string): string {
  const cut = text.lastIndexOf('\n') + 1
  const line = text.slice(cut).trim()
  return line.startsWith('`') && OPENER.startsWith(line) ? text.slice(0, cut).trimEnd() : text
}

function after(prefix: string, shown: string, raw: string): string {
  const said = withoutReplies(prefix)
  const base = [said, said.trimEnd(), held(said).trimEnd()].find(one => shown.startsWith(one))
  return (base === undefined ? withoutReplies(raw) : shown.slice(base.length)).trimStart()
}

// Text streamed under a message sent mid-answer: what follows the frozen prefix, without suggested replies.
export function liveTail(prefix: string, raw: string): string {
  return after(prefix, held(withoutReplies(prefix + raw)), raw)
}

// Final text under that message, keeping the full answer's closed replies block for the chips; null when nothing visible is left.
export function doneText(full: string, prefix: string | undefined, streamed: string): string | null {
  if (!prefix || !full.startsWith(prefix)) return full || streamed
  const tail = after(prefix, withoutReplies(full), full.slice(prefix.length))
  if (!tail.trim()) return null
  const open = full.search(REPLIES_OPEN)
  const lines = open < 0 ? [] : full.slice(open).split('\n')
  const close = lines.findIndex((line, index) => index > 0 && /^\s*```\s*$/.test(line))
  return close < 0 ? tail : `${tail.trimEnd()}\n\n${lines.slice(0, close + 1).join('\n')}`
}
