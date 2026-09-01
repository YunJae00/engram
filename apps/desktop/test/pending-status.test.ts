import { describe, expect, it } from 'vitest'
import { t } from '../src/renderer/src/i18n.js'
import { pendingStatus, stepLabel } from '../src/renderer/src/lib/pendingStatus.js'

describe('pendingStatus', () => {
  it('says the step the work is on', () => {
    expect(pendingStatus(t, 'search_web: lunch hours')).toBe('Searching the web for “lunch hours”')
  })
  it('falls back to the plain word before the first step', () => {
    expect(pendingStatus(t, undefined)).toBe('Thinking')
  })
})

describe('stepLabel', () => {
  it('leaves lines it does not recognise alone', () => {
    expect(stepLabel(t, '  <- search_memory: nothing in the vault')).toBe('  <- search_memory: nothing in the vault')
    expect(stepLabel(t, 'some_new_tool: arg')).toBe('some_new_tool: arg')
  })
})
