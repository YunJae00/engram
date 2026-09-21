import { randomUUID } from 'node:crypto'
import type { DevSession } from '../shared/developers.js'
import type { DevStore } from './dev-store.js'

export function devMessage(text: unknown): asserts text is string {
  if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error('Enter a message of up to 100,000 characters.')
}
export function pauseOutbox(session: DevSession): void {
  for (const message of session.outbox ?? []) if (message.state === 'queued') message.state = 'paused'
}

export class DevOutbox {
  private readonly draining = new Map<string, Promise<void>>()
  constructor(private readonly store: DevStore, private readonly changed: (session: DevSession) => void, private readonly send: (id: string, text: string) => Promise<void>) {}
  async add(session: DevSession, text: string): Promise<void> {
    devMessage(text)
    if ((session.outbox?.length ?? 0) >= 10) throw new Error('The queue holds up to 10 messages. Remove or send one first.')
    const message = { id: randomUUID(), text: text.trim(), state: session.state === 'failed' || session.state === 'stopping' ? 'paused' as const : 'queued' as const }
    session.outbox ??= []; session.outbox.push(message)
    try { await this.store.save() }
    catch (error) { message.state = 'paused'; this.changed(session); throw error }
    this.changed(session); this.schedule(session)
  }
  async update(session: DevSession, id: string, action: 'remove' | 'resume' | 'edit', text?: string): Promise<void> {
    const message = session.outbox?.find(value => value.id === id)
    if (!message || message.state === 'sending') throw new Error('This queued message is no longer editable.')
    if (!['remove', 'resume', 'edit'].includes(action)) throw new Error('Unknown queue action.')
    if (action === 'resume' && message.state === 'uncertain') throw new Error('Delivery was not confirmed. Review the conversation and files before sending a new message.')
    if (action === 'edit') { devMessage(text); message.text = text.trim() }
    else if (action === 'remove') session.outbox = session.outbox!.filter(value => value !== message)
    else message.state = 'queued'
    try { await this.store.save() }
    catch (error) { pauseOutbox(session); this.changed(session); throw error }
    this.changed(session); this.schedule(session)
  }
  schedule(session: DevSession): void {
    if (this.draining.has(session.id) || !this.store.data.preferences.enabled || session.state !== 'idle' || session.outbox?.[0]?.state !== 'queued') return
    const pending = this.drain(session).catch(() => { pauseOutbox(session); this.changed(session) }).finally(() => {
      this.draining.delete(session.id)
      // A turn may finish while its dispatch is still being persisted.
      this.schedule(session)
    })
    this.draining.set(session.id, pending)
  }
  async settle(): Promise<void> { await Promise.allSettled([...this.draining.values()]) }
  private async drain(session: DevSession): Promise<void> {
      while (this.store.data.preferences.enabled && session.state === 'idle') {
        const message = session.outbox?.[0]
        if (!message || message.state !== 'queued') break
        message.state = 'sending'; this.changed(session)
        try {
          await this.store.save()
          // Stop/disable may happen while the durable dispatch marker is being saved.
          if (!this.store.data.preferences.enabled || session.state !== 'idle' || message.state !== 'sending') { message.state = 'paused'; break }
          await this.send(session.id, message.text)
          session.outbox = session.outbox!.filter(value => value !== message)
          await this.store.save()
        } catch {
          message.state = 'uncertain'; pauseOutbox(session)
          await this.store.save(); break
        } finally { this.changed(session) }
      }
  }
}
