import { randomUUID } from 'node:crypto'

export interface DesktopControlLeaseState {
  state: 'idle' | 'needs-person' | 'running' | 'paused'
  lane?: string
  name?: string
  reason?: string
  expiresAt?: number
}

export interface DesktopControlLeaseOptions {
  now?: () => number
  token?: () => string
  ttlMs?: number
  onChange?: () => void
}

interface Grant {
  token: string
  lane: string
  name: string
  active: boolean
  expiresAt: number
}

const DEFAULT_TTL_MS = 10 * 60_000

// One instance belongs to the application, not to a chat or native helper.
export class DesktopControlLease {
  private readonly now: () => number
  private readonly makeToken: () => string
  private readonly ttlMs: number
  private readonly onChange?: () => void
  private grant: Grant | null = null
  private paused: DesktopControlLeaseState | null = null
  private epoch = 0
  private inFlight = false

  constructor(options: DesktopControlLeaseOptions = {}) {
    this.now = options.now ?? Date.now
    this.makeToken = options.token ?? randomUUID
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.onChange = options.onChange
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error('Control lifetime must be positive and finite.')
  }

  private changed(): void {
    try { this.onChange?.() }
    catch { /* An observer cannot interrupt revocation or native action cleanup. */ }
  }

  private pause(reason: string): void {
    const grant = this.grant
    if (!grant) return
    this.grant = null
    this.paused = { state: 'paused', lane: grant.lane, name: grant.name, reason }
    this.changed()
  }

  private expire(): void {
    if (!this.grant) return
    const now = this.now()
    if (!Number.isFinite(now) || now >= this.grant.expiresAt) this.pause('Desktop control expired. Allow it again to continue.')
  }

  private deadline(): number {
    const expiresAt = this.now() + this.ttlMs
    if (!Number.isFinite(expiresAt)) throw new Error('The control lifetime could not be established.')
    return expiresAt
  }

  reserve(lane: string, name: string): string {
    this.expire()
    if (typeof lane !== 'string' || !/^bot-[a-zA-Z0-9_-]{1,140}$/.test(lane)) throw new Error('Choose a valid chat first.')
    if (typeof name !== 'string' || !name.trim() || name.length > 1024 || name.includes('\0')) throw new Error('Choose a valid app window name.')
    if (this.grant) throw new Error('Another desktop control request is already pending or running.')
    const expiresAt = this.deadline()
    const nonce = this.makeToken()
    if (typeof nonce !== 'string' || !nonce) throw new Error('A control token could not be created.')
    // A caller-supplied token source must not resurrect an earlier grant.
    const token = `${nonce}:${++this.epoch}`
    this.grant = { token, lane, name, active: false, expiresAt }
    this.paused = null
    this.changed()
    return token
  }

  activate(token: string): void {
    this.expire()
    const grant = this.grant
    if (!grant || grant.token !== token) throw new Error('The desktop control request ended. Ask the person again.')
    if (grant.active) throw new Error('Desktop control is already active.')
    grant.expiresAt = this.deadline()
    grant.active = true
    this.changed()
  }

  assertActive(token: string, lane: string): void {
    this.expire()
    const grant = this.grant
    if (!grant?.active || grant.token !== token || grant.lane !== lane) throw new Error('Desktop control ended or belongs to another chat.')
  }

  stop(reason = 'Desktop control stopped. Allow it again to continue.'): void {
    this.expire()
    this.pause(reason)
  }

  reset(): void {
    this.expire()
    if (!this.grant && !this.paused) return
    this.grant = null
    this.paused = null
    this.changed()
  }

  state(): DesktopControlLeaseState {
    this.expire()
    const grant = this.grant
    if (grant) return { state: grant.active ? 'running' : 'needs-person', lane: grant.lane, name: grant.name, expiresAt: grant.expiresAt }
    return this.paused ? { ...this.paused } : { state: 'idle' }
  }

  tokenFor(lane: string): string | null {
    this.expire()
    return this.grant?.active && this.grant.lane === lane ? this.grant.token : null
  }

  async run<T>(token: string, lane: string, work: () => Promise<T>): Promise<T> {
    this.assertActive(token, lane)
    if (this.inFlight) throw new Error('A desktop action is still in progress. Read the window again after it finishes.')
    this.inFlight = true
    try {
      let result: T
      try { result = await work() }
      catch (error) {
        if (this.grant?.token === token) this.pause('The desktop action failed. Allow control again to continue.')
        throw error
      }
      this.assertActive(token, lane)
      return result
    } finally {
      // Revoking or resetting the grant cannot cancel already dispatched native
      // work. Keep its slot occupied until settlement to prevent overlap.
      this.inFlight = false
    }
  }
}
