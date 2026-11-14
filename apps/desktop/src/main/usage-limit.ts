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
