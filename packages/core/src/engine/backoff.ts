
const BASE_MS = 5 * 60_000
const CAP_MS = 60 * 60_000
const OUTAGE_BASE_MS = 60_000
const OUTAGE_CAP_MS = 10 * 60_000

export class EngineBackoff {
  private until = 0
  private streak = 0
  private outages = 0

  constructor(private rng: () => number = Math.random) {}

  noteQuota(retryAfterMs?: number, now: number = Date.now()): void {
    this.streak += 1
    const backoff = Math.min(CAP_MS, BASE_MS * 2 ** this.streak)
    const jittered = backoff * (0.5 + this.rng() * 0.5)
    const wait = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : jittered
    this.until = Math.max(this.until, now + wait)
  }

  noteOutage(now: number = Date.now()): void {
    const wait = Math.min(OUTAGE_CAP_MS, OUTAGE_BASE_MS * 2 ** this.outages)
    this.outages += 1
    this.until = Math.max(this.until, now + wait)
  }

  noteOk(): void {
    this.until = 0
    this.streak = 0
    this.outages = 0
  }

  blockedMs(now: number = Date.now()): number {
    return Math.max(0, this.until - now)
  }
}

export const engineBackoff = new EngineBackoff()
