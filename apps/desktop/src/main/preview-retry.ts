export class PreviewRetry {
  private failures = new Map<string, { count: number; after: number }>()
  private logs = new Map<string, number>()
  ready(key: string, now = Date.now()): boolean { return now >= (this.failures.get(key)?.after ?? 0) }
  fail(key: string, now = Date.now()): number {
    const count = (this.failures.get(key)?.count ?? 0) + 1
    const delay = Math.min(30_000, 3000 * 2 ** Math.min(count - 1, 4))
    this.failures.set(key, { count, after: now + delay })
    if (this.failures.size > 128) this.failures.delete(this.failures.keys().next().value!)
    return delay
  }
  reset(key: string): void { this.failures.delete(key) }
  log(key: string, reason: string, now = Date.now()): boolean {
    const id = `${key}:${reason}`
    if (now - (this.logs.get(id) ?? -Infinity) < 60_000) return false
    this.logs.set(id, now)
    if (this.logs.size > 256) this.logs.delete(this.logs.keys().next().value!)
    return true
  }
  clear(): void { this.failures.clear(); this.logs.clear() }
}
