import { describe, expect, it } from 'vitest'
import { resolveTheme, THEME_NEEDED } from '../src/office-theme.js'

describe('resolveTheme', () => {
  it('expands the two brand colours and fonts into a full theme', () => {
    const theme = resolveTheme({ field: '#1F3B5B', accent: 'c0603b', fonts: { title: 'Georgia', body: 'Segoe UI' } })
    expect(theme).not.toBeNull()
    expect(theme!.colors.field).toBe('1F3B5B')
    expect(theme!.colors.accent).toBe('C0603B')
    expect(theme!.fonts.title).toBe('Georgia')
    // The structural neutrals are filled in, never dictated by the model.
    expect(theme!.colors.paper).toBe('FFFFFF')
    expect(theme!.colors.onField).toBe('FFFFFF')
    expect(theme!.colors.chart[0]).toBe('1F3B5B')
    expect(theme!.colors.chart[1]).toBe('C0603B')
  })

  it('takes extra chart hues from the model and invents none itself', () => {
    const plain = resolveTheme({ field: '1F3B5B', accent: 'C0603B', fonts: { title: 'Georgia', body: 'Segoe UI' } })!
    // With no extra hues the palette is exactly the two brand colours plus the
    // neutral - nothing brand-like is fabricated.
    expect(plain.colors.chart).toEqual(['1F3B5B', 'C0603B', '6B7280'])
    const rich = resolveTheme({ field: '1F3B5B', accent: 'C0603B', chart: ['#2FA98C', 'e8a317', 'bad'], fonts: { title: 'Georgia', body: 'Segoe UI' } })!
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

  it('carries an ask-the-person message for when nothing was passed', () => {
    expect(THEME_NEEDED).toContain('Ask the person')
  })
})
