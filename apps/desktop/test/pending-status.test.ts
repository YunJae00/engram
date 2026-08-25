import { describe, expect, it } from 'vitest'
import { t } from '../src/renderer/src/i18n.js'
import { pendingStatus, stepLabel } from '../src/renderer/src/lib/pendingStatus.js'

describe('pendingStatus', () => {
  it('says loading over everything else', () => {
    expect(pendingStatus(t, { warm: 'loading', progress: { phase: 'writing', kind: 'prose', done: 9, words: 4 } }, 'search_memory: x')).toBe('Warming up the model')
  })
  it('counts the prompt being read, before and after a step', () => {
    const progress = { phase: 'reading' as const, kind: 'choice' as const, done: 512, total: 1300 }
    expect(pendingStatus(t, { warm: 'ready', progress }, undefined)).toBe('Reading your message · 512 of 1300 tokens')
    expect(pendingStatus(t, { warm: 'ready', progress }, 'search_memory: deploy')).toBe('Reading what it found · 512 of 1300 tokens')
  })
  it('tells a choice from prose while writing', () => {
    expect(pendingStatus(t, { warm: 'ready', progress: { phase: 'writing', kind: 'choice', done: 14 } }, undefined)).toBe('Working out the next move · 14 tokens')
    expect(pendingStatus(t, { warm: 'ready', progress: { phase: 'writing', kind: 'prose', done: 60, words: 42 } }, undefined)).toBe('Writing the answer · 42 words')
  })
  it('falls back to the step, then to the plain word', () => {
    expect(pendingStatus(t, { warm: 'ready', progress: null }, 'search_web: lunch hours')).toBe('Searching the web for “lunch hours”')
    expect(pendingStatus(t, { warm: 'ready', progress: null }, undefined)).toBe('Thinking')
  })
})

describe('stepLabel', () => {
  it('leaves lines it does not recognise alone', () => {
    expect(stepLabel(t, '  <- search_memory: nothing in the vault')).toBe('  <- search_memory: nothing in the vault')
    expect(stepLabel(t, 'some_new_tool: arg')).toBe('some_new_tool: arg')
  })
})
