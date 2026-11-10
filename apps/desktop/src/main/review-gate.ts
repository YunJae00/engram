import { evaluate, hostOf, type ReviewAction, type ReviewRule } from 'core'

// Only web page submits are evaluated; every other url keeps the card path unchanged.
export function reviewAction(url: string): ReviewAction | undefined {
  let protocol: string
  try { protocol = new URL(url).protocol } catch { return undefined }
  const host = protocol === 'http:' || protocol === 'https:' ? hostOf(url) : null
  return host ? { operation: 'submit', target: host } : undefined
}

export async function readRules(read?: () => Promise<readonly ReviewRule[]>): Promise<readonly ReviewRule[]> {
  try { return read ? await read() : [] } catch { return [] }
}

export function allowedByRule(rules: readonly ReviewRule[], url: string): boolean {
  const action = reviewAction(url)
  return !!action && evaluate(rules, action) === 'allow'
}
