import { describe, expect, it } from 'vitest'
import { botFiles } from '../src/renderer/src/lib/botFiles.js'
import type { CometMessage } from '../src/renderer/src/lib/cometThreads.js'

const A = '11111111-1111-4111-8111-111111111111-sheet.csv'
const B = '33333333-3333-4333-8333-333333333333-notes.txt'
const F = '22222222-2222-4222-8222-222222222222-report.pdf'
const link = (id: string, name: string) => `[${name}](engram-artifact:${id})`
const user = (attachments: unknown, at = '2026-01-10T09:00:00.000Z') => ({ role: 'user', text: 'x', at, attachments }) as CometMessage
const answer = (text: string, extra: Partial<CometMessage> = {}) => ({ role: 'assistant', text, at: '2026-01-10T09:00:05.000Z', ...extra }) as CometMessage

describe('collects attachments and answer files, dedup', () => {
  it('lists attachments and answer files newest first, each once', () => {
    const messages = [user([A]), answer(`Done ${link(F, 'report.pdf')}\n\nAgain ${link(F, 'report.pdf')}`), user([A])]
    expect(botFiles(messages)).toEqual([
      { kind: 'attachment', id: A, name: 'sheet.csv' },
      { kind: 'answer', id: F, name: 'report.pdf' },
    ])
  })

  it('keeps the newest occurrence and the order inside one turn', () => {
    const messages = [user([B]), answer('no files'), user([A, B])]
    expect(botFiles(messages).map(f => f.id)).toEqual([A, B])
  })

  it('skips streaming, failed and progress messages', () => {
    const messages = [
      answer(link(F, 'report.pdf'), { streaming: true }),
      answer(link(F, 'report.pdf'), { error: true }),
      answer(link(F, 'report.pdf'), { progress: true }),
      { ...user([A]), streaming: true } as CometMessage,
    ]
    expect(botFiles(messages)).toEqual([])
  })

  it('skips malformed attachments without throwing', () => {
    const messages = [user('not an array'), user([42, null, 'plain-name.txt', `${A.slice(0, 37)}`, A]), null, 7, { role: 'assistant', text: 5 }] as unknown as CometMessage[]
    const copy = JSON.parse(JSON.stringify(messages)) as unknown
    expect(botFiles(messages)).toEqual([{ kind: 'attachment', id: A, name: 'sheet.csv' }])
    expect(messages).toEqual(copy)
    expect(botFiles(messages)).not.toBe(botFiles(messages))
  })

  it('orders by message position, never by at', () => {
    const messages = [user([A], '2030-01-01T00:00:00.000Z'), user([B], 'not a date'), { role: 'assistant', text: link(F, 'report.pdf') } as CometMessage]
    expect(botFiles(messages).map(f => f.id)).toEqual([F, B, A])
  })
})
