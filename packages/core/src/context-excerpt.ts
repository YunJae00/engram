// Keep both conclusions and introductions; omitted material stays in the transcript.
export function contextExcerpt(text: string, limit: number): string {
  if (text.length <= limit) return text
  const note = '\n[Middle omitted; search_chats can recover the full conversation.]\n'
  const side = Math.max(0, Math.floor((limit - note.length) / 2))
  return text.slice(0, side) + note + text.slice(-side)
}
