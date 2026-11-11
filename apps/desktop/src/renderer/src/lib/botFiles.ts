import type { CometMessage } from './cometThreads.js'
import { answerFiles } from '../markdown.js'

export type BotFile = { kind: 'attachment' | 'answer'; id: string; name: string }

const ATTACHMENT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-./i

function turnFiles(m: CometMessage): BotFile[] {
  const out: BotFile[] = []
  if (m.role === 'user') {
    const list: unknown = m.attachments
    if (!Array.isArray(list)) return out
    for (let i = 0; i < list.length; i++) {
      const id: unknown = list[i]
      if (typeof id === 'string' && ATTACHMENT_ID.test(id)) out.push({ kind: 'attachment', id, name: id.slice(37) })
    }
  } else if (m.role === 'assistant' && typeof m.text === 'string') {
    for (const file of answerFiles(m.text).files) out.push({ kind: 'answer', id: file.id, name: file.name })
  }
  return out
}

export function botFiles(messages: readonly CometMessage[]): BotFile[] {
  const seen = new Set<string>()
  const files: BotFile[] = []
  if (!Array.isArray(messages)) return files
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: unknown = messages[i]
    if (typeof m !== 'object' || m === null) continue
    const turn = m as CometMessage
    if (turn.streaming === true || turn.error === true || turn.progress === true) continue
    for (const file of turnFiles(turn)) {
      const key = `${file.kind}\n${file.id}`
      if (seen.has(key)) continue
      seen.add(key)
      files.push(file)
    }
  }
  return files
}
