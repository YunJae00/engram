import { describe, expect, it } from 'vitest'
import { auditDeck, deckBodyLayout, describeDeckFindings } from '../src/deck-audit.js'

describe('auditDeck', () => {
  it('rejects an overflowing table and stacked content before rendering', () => {
    expect(auditDeck([{ title: 'Sales', table: { rows: Array.from({ length: 30 }, () => ['Item', 1]) } }])).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'overflow' })]))
    expect(auditDeck([{ title: 'Sales', bullets: Array(7).fill('Point'), table: { rows: Array(8).fill(['Item', 1]) }, chart: {} }])).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'overflow' })]))
  })
  it('sizes bullets and places following content below them', () => {
    const layout = deckBodyLayout({ title: 'Steps', subtitle: 'Overview', bullets: Array(7).fill('Point') })
    expect(layout.top).toBeGreaterThanOrEqual(2)
    expect(layout.bulletsHeight).toBeGreaterThan(3)
    expect(layout.tableTop).toBeGreaterThan(layout.top + layout.bulletsHeight)
    expect(layout.chartTop).toBeLessThan(6.8)
    const longSubtitle = deckBodyLayout({ title: 'Detail', subtitle: '가'.repeat(300), bullets: ['Point'] })
    expect(longSubtitle.subtitleHeight).toBeGreaterThan(1)
    expect(longSubtitle.top).toBeGreaterThan(1.5 + longSubtitle.subtitleHeight)
  })
  it('passes a clean deck', () => {
    expect(auditDeck([
      { title: 'Market entry', subtitle: 'Q4 plan' },
      { title: 'Findings', bullets: ['Revenue up 12%', 'Two new segments'] },
    ])).toEqual([])
  })

  it('catches an unfilled placeholder', () => {
    const found = auditDeck([{ title: 'TODO', bullets: ['[client name]', 'real point'] }])
    expect(found.map((f) => f.kind)).toEqual(['placeholder', 'placeholder'])
  })

  it('catches a line about the deck itself, in English or Korean', () => {
    expect(auditDeck([{ title: 'Intro', bullets: ['This slide summarizes the approach.'] }])[0]?.kind).toBe('process')
    expect(auditDeck([{ title: '개요', bullets: ['본 슬라이드는 분석 결과를 정리했습니다'] }])[0]?.kind).toBe('process')
  })

  it('does not flag an ordinary arrow or label-colon line', () => {
    expect(auditDeck([{ title: 'Flow', bullets: ['기획 → 설계 → 개발', '매출 : 1,200억'] }])).toEqual([])
  })

  it('catches overflow and duplicate titles', () => {
    const found = auditDeck([
      { title: 'x'.repeat(80) },
      { title: 'Same' },
      { title: 'Same', bullets: ['a'.repeat(200)] },
      { title: 'Many', bullets: ['1', '2', '3', '4', '5', '6', '7', '8'] },
    ])
    const kinds = found.map((f) => f.kind)
    expect(kinds).toContain('overflow')
    expect(kinds).toContain('duplicate')
    expect(found.filter((f) => f.kind === 'overflow').length).toBeGreaterThanOrEqual(3)
  })

  it('describes findings as one actionable paragraph, empty when clean', () => {
    expect(describeDeckFindings([])).toBe('')
    const text = describeDeckFindings(auditDeck([{ title: 'TBD' }]))
    expect(text).toContain('does not read clean')
    expect(text).toContain('slide 1')
  })
})
