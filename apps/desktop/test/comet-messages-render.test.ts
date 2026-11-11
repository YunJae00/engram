import { describe, expect, it } from 'vitest'
import { sameTurn, type TurnKeys } from '../src/renderer/src/lib/sameTurn.js'

const m = { role: 'assistant', text: 'hello' }
const base = (): TurnKeys => ({ message: m, live: false, divider: null, lang: 'en', anchor: '--copy-a-0', work: ['one', 'two'], retry: false })

describe('MessageTurn comparator', () => {
  it('sameTurn ignores callback identity and compares the message by reference', () => {
    const a = { ...base(), onRetry: () => {} }
    const b = { ...base(), onRetry: () => {}, extra: 1 }
    expect(sameTurn(a, b)).toBe(true)
    expect(sameTurn(base(), { ...base(), work: ['one', 'two'] })).toBe(true)
    expect(sameTurn(base(), { ...base(), message: { role: 'assistant', text: 'hello' } })).toBe(false)
  })

  it('sameTurn compares live, divider, lang, anchor, retry and work element by element', () => {
    const changes: Partial<TurnKeys>[] = [
      { live: true }, { divider: 'Today' }, { lang: 'ko' }, { anchor: '--copy-a-1' }, { retry: true },
      { work: ['one'] }, { work: ['one', 'two', 'three'] }, { work: ['one', 'TWO'] },
    ]
    for (const change of changes) expect(sameTurn(base(), { ...base(), ...change })).toBe(false)
    expect(sameTurn({ ...base(), divider: 'Today' }, { ...base(), divider: 'Yesterday' })).toBe(false)
    expect(sameTurn({ ...base(), divider: 'Today' }, { ...base(), divider: 'Today' })).toBe(true)
  })
})
