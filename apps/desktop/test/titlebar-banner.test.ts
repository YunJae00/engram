import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en } from '../src/renderer/src/i18n'
import { ko4 } from '../src/renderer/src/i18n-ko-4'

const EN = "{provider} is selected for filing but isn't ready. Check its connection or choose another AI in Settings."
const placeholders = (value: string) => (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort()

describe('titlebar connect banner copy', () => {
  it('filing-not-ready key keeps the English text', () => {
    expect(en['banner.filingNotReady']).toBe(EN)
    for (const file of ['AppNotices.tsx', 'TopBar.tsx']) {
      const source = readFileSync(new URL(`../src/renderer/src/components/${file}`, import.meta.url), 'utf8')
      expect(source).not.toContain('is selected for filing')
    }
  })

  it('filing-not-ready ko value is Korean with the same placeholder', () => {
    const value = ko4['banner.filingNotReady']
    expect(value).toMatch(/[가-힣]/)
    expect(placeholders(value)).toEqual(placeholders(EN))
    expect(value).not.toMatch(/\{provider\}(이|가|을|를|은|는|과|와|으로|로)/)
  })
})
