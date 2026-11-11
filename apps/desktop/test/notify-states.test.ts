import { expect, it } from 'vitest'
import { markUnread, rowStatus, unreadAfter } from '../src/renderer/src/lib/botRowStatus.js'

const a = { role: 'assistant' as const, text: 'one', at: 't1' }
const b = { ...a, text: 'two', at: 't2' }

it('row status: attention over working over unread', () => {
  expect(rowStatus('waiting', true)).toBe('attention')
  expect(rowStatus('error', true)).toBe('attention')
  expect(rowStatus('running', true)).toBe('working')
  expect(rowStatus('running', false)).toBe('working')
  expect(rowStatus('ready', true)).toBe('unread')
  expect(rowStatus('ready', false)).toBeNull()
})

it('unread: new assistant answer after first sight, cleared when active', () => {
  const first = unreadAfter(undefined, a, false)
  expect(first.unread).toBe(false)
  const keyB = unreadAfter(undefined, b, false).seen
  const later = unreadAfter(first.seen, b, false)
  expect(later).toEqual({ seen: first.seen, unread: true })
  expect(unreadAfter(later.seen, b, false).unread).toBe(true)
  expect(unreadAfter(first.seen, { role: 'user', text: 'mine', at: 't3' }, false).unread).toBe(false)
  expect(unreadAfter(first.seen, b, true)).toEqual({ seen: keyB, unread: false })
  expect(unreadAfter(keyB, b, false).unread).toBe(false)
  expect(unreadAfter('', undefined, false).unread).toBe(false)
})

it('markUnread keeps state per bot id', () => {
  expect(markUnread('ns-x', a, false)).toBe(false)
  expect(markUnread('ns-y', a, false)).toBe(false)
  expect(markUnread('ns-x', b, false)).toBe(true)
  expect(markUnread('ns-y', a, false)).toBe(false)
  expect(markUnread('ns-x', b, true)).toBe(false)
  expect(markUnread('ns-x', b, false)).toBe(false)
})
