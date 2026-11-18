export type EngineErrorKind = 'auth' | 'quota' | 'outage' | 'network' | 'timeout' | 'crash' | 'unknown'

const QUOTA = /\b429\b|rate.?limit|quota|usage limit|too many requests/i

const AUTH =
  /invalid api key|please run\s+\/?login|\/login\b|not logged ?in|log ?in again|unauthori[sz]ed|authentication|credentials?\b|oauth|\b401\b|\b403\b|token (?:is |has )?expired|expired token|session expired/i

const OUTAGE =
  /stream (?:disconnected|closed) before|before response\.completed|\b50[0234]\b|bad gateway|service unavailable|temporarily unavailable|overloaded|internal server error|server_error|upstream (?:connect )?error/i

const NETWORK =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPROTO|socket hang up|network error|fetch failed|getaddrinfo|proxy|certificate|self.signed|unable to (?:verify|get local issuer)|tunneling socket/i

const TIMEOUT = /\[engram\] timed out|\[engram\] stalled|timed? ?out|timeout/i

const CRASH =
  /exited \d+|exited null|killed|SIGKILL|SIGTERM|ENOENT|not recognized|command not found|empty engine result|out of memory|heap/i

export function classifyEngineError(message: string, exitCode?: number | null): EngineErrorKind {
  if (QUOTA.test(message)) return 'quota'
  if (AUTH.test(message)) return 'auth'
  if (OUTAGE.test(message)) return 'outage'
  if (NETWORK.test(message)) return 'network'
  if (TIMEOUT.test(message)) return 'timeout'
  if (CRASH.test(message)) return 'crash'
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) return 'crash'
  return 'unknown'
}

export function parseRetryAfterMs(text: string, now: number = Date.now()): number | undefined {
  const seconds = /retry[- ]?after[:\s]+(\d+)/i.exec(text)?.[1]
  if (seconds) return Number(seconds) * 1000
  const epoch = /resets? at\D{0,10}(\d{10})\b/i.exec(text)?.[1]
  if (epoch) {
    const ms = Number(epoch) * 1000 - now
    if (ms > 0) return ms
  }
  return undefined
}
