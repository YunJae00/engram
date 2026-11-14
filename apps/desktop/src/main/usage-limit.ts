import { parseRetryAfterMs } from 'core'

// How long until Claude's limit resets, from its own error text when it says:
// "usage limit reached|<epoch>", "resets 3pm", "retry after 120", "resets at <epoch>".
export function claudeRetryAfterMs(text: string, now = Date.now()): number | undefined {
  const generic = parseRetryAfterMs(text, now)
  if (generic && generic > 0) return generic
  const epoch = /limit reached\s*\|\s*(\d{10})\b/i.exec(text)?.[1]
  if (epoch && Number(epoch) * 1000 > now) return Number(epoch) * 1000 - now
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text)
  if (!clock) return undefined
  const at = new Date(now)
  at.setHours((Number(clock[1]) % 12) + (clock[3]!.toLowerCase() === 'pm' ? 12 : 0), Number(clock[2] ?? 0), 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime() - now
}

// What the person reads when Claude is at its usage limit: when it can pick up
// again, in their language. No other engine takes over.
export function usageLimitMessage(korean: boolean, until?: number, now = Date.now()): string {
  const at = until && until > now ? new Date(until) : undefined
  if (korean) {
    if (!at) return 'AI 사용 한도에 도달했어요. 잠시 후에 다시 이어서 할 수 있어요.'
    const h = at.getHours(), m = at.getMinutes()
    const clock = `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}시${m ? ` ${m}분` : ''}`
    return `AI 사용 한도에 도달했어요. ${clock}쯤 다시 이어서 할 수 있어요.`
  }
  if (!at) return 'AI usage limit reached. I can pick this up again in a while.'
  const clock = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: at.getMinutes() ? '2-digit' : undefined })
  return `AI usage limit reached. I can pick this up again around ${clock}.`
}
