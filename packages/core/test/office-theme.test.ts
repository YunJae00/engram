import { describe, expect, it } from 'vitest'
import { faceFor, HOUSE_THEME, KOREAN_FACE, resolveTheme, THEME_NEEDED } from '../src/office-theme.js'

describe('resolveTheme', () => {
  it('expands the two brand colours and fonts into a full theme', () => {
    const theme = resolveTheme({ field: '#1F3B5B', accent: 'c0603b', fonts: { title: 'Georgia', body: 'Segoe UI' } })
    expect(theme).not.toBeNull()
    expect(theme!.colors.field).toBe('1F3B5B')
    expect(theme!.colors.accent).toBe('C0603B')
    expect(theme!.fonts.title).toBe('Georgia')
    expect(theme!.colors.paper).toBe('FFFFFF')
    expect(theme!.colors.onField).toBe('FFFFFF')
    expect(theme!.colors.chart[0]).toBe('1F3B5B')
    expect(theme!.colors.chart[1]).toBe('C0603B')
  })

  it('takes extra chart hues from the model and invents none itself', () => {
    const plain = resolveTheme({ field: '1F3B5B', accent: 'C0603B', fonts: { title: 'Georgia', body: 'Segoe UI' } })!
    expect(plain.colors.chart).toEqual(['1F3B5B', 'C0603B', '6B7280'])
    const rich = resolveTheme({ field: '1F3B5B', accent: 'C0603B', chart: ['#2FA98C', 'e8a317'], fonts: { title: 'Georgia', body: 'Segoe UI' } })!
    expect(rich.colors.chart).toEqual(['1F3B5B', 'C0603B', '6B7280', '2FA98C', 'E8A317'])
  })

  it('lets the model override the structural ink and paper when it wants to', () => {
    const theme = resolveTheme({ field: '112233', accent: '445566', ink: '000000', paper: 'FAF7F0', fonts: { title: 'Georgia', body: 'Arial' } })
    expect(theme!.colors.ink).toBe('000000')
    expect(theme!.colors.paper).toBe('FAF7F0')
  })

  it.each([
    undefined,
    null,
    'navy',
    {},
    { field: '1F3B5B', fonts: { title: 'Georgia', body: 'Segoe UI' } },
    { field: 'nothex', accent: 'C0603B', fonts: { title: 'Georgia', body: 'Segoe UI' } },
    { field: '1F3B5B', accent: 'C0603B', fonts: { title: 'Georgia' } },
    { field: '1F3B5B', accent: 'C0603B', fonts: { title: '', body: 'Segoe UI' } },
  ])('returns null for an unusable brand (%#)', (input) => {
    expect(resolveTheme(input)).toBeNull()
  })

  it('carries a house look for when nothing usable was passed, and never an ask', () => {
    expect(THEME_NEEDED).toContain('Never ask the person')
    expect(THEME_NEEDED).not.toMatch(/^Ask|\bAsk the person for/)
    expect(HOUSE_THEME.colors.onField).toBe('FFFFFF')
    expect(HOUSE_THEME.colors.accent).not.toBe(HOUSE_THEME.colors.field)
    expect(faceFor('매출: 수치 입력', HOUSE_THEME.fonts.body)).toBe(HOUSE_THEME.fonts.body)
  })
  it('gives text with Hangul a face that carries Korean, and leaves other text and Korean faces alone', () => {
    expect(faceFor('매출: 수치 입력', 'Segoe UI')).toBe(KOREAN_FACE)
    expect(faceFor('Q3 revenue', 'Segoe UI')).toBe('Segoe UI')
    expect(faceFor('매출', 'Pretendard')).toBe('Pretendard')
    expect(faceFor('매출', '맑은 고딕')).toBe('맑은 고딕')
  })

  it('keeps text readable on light fields and rejects malformed optional values', () => {
    const input = { field: 'FFFFCC', accent: '445566', fonts: { title: 'Georgia', body: 'Arial' } }
    expect(resolveTheme(input)!.colors.onField).toBe('000000')
    for (const invalid of [{ ink: 'red' }, { paper: null }, { chart: ['bad'] }, { chart: '112233' }, { chart: Array(13).fill('112233') }, { unexpected: true }, { fonts: { ...input.fonts, body: 'Arial\u0000' } }, { fonts: { ...input.fonts, unknown: 'font' } }]) {
      expect(resolveTheme({ ...input, ...invalid })).toBeNull()
    }
  })
})
