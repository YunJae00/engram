
const BASE_MS = 5 * 60_000
const CAP_MS = 60 * 60_000
// A provider failing on its side usually recovers within minutes.
const OUTAGE_BASE_MS = 60_000
const OUTAGE_CAP_MS = 10 * 60_000

export class EngineBackoff {
  private until = 0
  private streak = 0
  private outages = 0

  constructor(private rng: () => number = Math.random) {}

  // A quota hit: arm (or extend) the gate. retryAfterMs, when the CLI said
  // one, is authoritative; otherwise the exponential schedule applies.
  noteQuota(retryAfterMs?: number, now: number = Date.now()): void {
    this.streak += 1
    const backoff = Math.min(CAP_MS, BASE_MS * 2 ** this.streak)
    // Full-ish jitter: [half, full] of the exponential step.
    const jittered = backoff * (0.5 + this.rng() * 0.5)
    const wait = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : jittered
    // Extend only — concurrent workers hitting the same wall must not shorten
    // an already-armed gate.
    this.until = Math.max(this.until, now + wait)
  }

  // A provider failing on its side: wait a minute, then longer while it keeps failing.
  noteOutage(now: number = Date.now()): void {
    const wait = Math.min(OUTAGE_CAP_MS, OUTAGE_BASE_MS * 2 ** this.outages)
    this.outages += 1
    this.until = Math.max(this.until, now + wait)
  }

  // A successful call is the only thing that clears the gate (SPEC: quota is
  // never cleared by an auth check — only by the limit actually lifting).
  noteOk(): void {
    this.until = 0
    this.streak = 0
    this.outages = 0
  }

  // 0 = go; positive = this many ms before anyone should spawn.
  blockedMs(now: number = Date.now()): number {
    return Math.max(0, this.until - now)
  }
}

// The process-wide instance every production caller shares. Tests construct
// their own — a singleton that leaks state between tests convicts innocents.
export const engineBackoff = new EngineBackoff()
