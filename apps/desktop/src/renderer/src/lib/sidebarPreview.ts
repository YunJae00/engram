import { withoutReplies } from '../../../../../../packages/core/src/agent-history.js'
import { normalizeProse } from '../../../../../../packages/core/src/prose.js'

export function sidebarPreview(text: string): string {
  // A sidebar excerpt never needs to parse an entire pasted document.
  return normalizeProse(withoutReplies(text.slice(0, 2048))).replace(/!?\[([^[\]]+)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, '$1').replace(/^\s*[-+]\s+/gm, '').replace(/:?-{3,}:?|\|/g, ' ').replace(/[`#*_>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)
}
