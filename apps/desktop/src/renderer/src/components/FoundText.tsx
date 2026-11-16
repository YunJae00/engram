import { markParts } from '../lib/sidebarBots.js'

// The search words marked inside an excerpt. React escapes each piece, so words from a conversation never become markup.
export function FoundText({ text, search }: { text: string; search: string }) {
  return <>{markParts(text, search).map((part, index) => part.hit ? <mark key={index}>{part.text}</mark> : part.text)}</>
}
