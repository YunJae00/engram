// Why an engine call failed, in the only vocabulary a user can act on.
//
// Until now every failure collapsed into one opaque string, so the app said
// "the login may have expired" whether the token was dead, the account was
// over its usage limit, a proxy ate the request, or the CLI crashed. Those
// four states need four different sentences because they need four different
// actions (log in / wait / fix the network / retry), and the only place that
// can tell them apart is the boundary where the CLI's stderr and exit code
// still exist — hence classification lives beside the adapter, not in the UI.
export type EngineErrorKind = 'auth' | 'quota' | 'network' | 'timeout' | 'crash' | 'unknown'

// Order below is deliberate: a message can match several patterns and the
// FIRST match wins, so the most actionable reading is tested first.

// Rate/usage limits.
const QUOTA = /\b429\b|rate.?limit|quota|usage limit|too many requests/i

// A dead or unusable login. `claude` reports this as prose on stderr, or as an
// HTTP status when the API rejects the token outright.
const AUTH =
  /invalid api key|please run\s+\/?login|\/login\b|not logged ?in|log ?in again|unauthori[sz]ed|authentication|credentials?\b|oauth|\b401\b|\b403\b|token (?:is |has )?expired|expired token|session expired/i

// The request never reached Anthropic: DNS, TCP, proxy, or TLS interception.
const NETWORK =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPROTO|socket hang up|network error|fetch failed|getaddrinfo|proxy|certificate|self.signed|unable to (?:verify|get local issuer)|tunneling socket/i

const TIMEOUT = /\[engram\] timed out|\[engram\] stalled|timed? ?out|timeout/i

// The process itself died or produced nothing usable.
const CRASH =
  /exited \d+|exited null|killed|SIGKILL|SIGTERM|ENOENT|not recognized|command not found|empty engine result|out of memory|heap/i

// `exitCode` is the CLI's own exit status when the caller has it; a non-zero
// exit with no recognisable text is still a crash, not an "unknown" we would
// then render as a shrug.
export function classifyEngineError(message: string, exitCode?: number | null): EngineErrorKind {
  if (QUOTA.test(message)) return 'quota'
  if (AUTH.test(message)) return 'auth'
  if (NETWORK.test(message)) return 'network'
  if (TIMEOUT.test(message)) return 'timeout'
  if (CRASH.test(message)) return 'crash'
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) return 'crash'
  return 'unknown'
}
