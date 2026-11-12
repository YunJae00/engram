import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, type Rgba } from '../e2e/visual/spec.js'

const SRC = join(__dirname, '../src/renderer/src')
const css = readFileSync(join(SRC, 'styles.css'), 'utf8')
const chat = readFileSync(join(SRC, 'comet-chat.css'), 'utf8')

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing block ${selector}`)
  return css.slice(start, css.indexOf('\n}', start))
}

const THEMES = { light: block("[data-theme='light']"), dark: block("[data-theme='dark']") }
type Theme = keyof typeof THEMES

function raw(theme: Theme, name: string): string {
  const found = [...THEMES[theme].matchAll(new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+);`, 'gm'))]
  if (found.length !== 1) throw new Error(`${theme} ${name} declared ${found.length} times`)
  return found[0]![1]!.trim()
}

function hex(theme: Theme, name: string): string {
  const value = raw(theme, name)
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  if (alias) return hex(theme, alias[1]!)
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${theme} ${name} is not #rrggbb: ${value}`)
  return value.toLowerCase()
}

const rgba = (h: string): Rgba => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 1]
const SURFACES = ['--app-bg', '--rail-bg', '--bubble-bg', '--selected-soft']
const minContrast = (theme: Theme, fg: string, surfaces = SURFACES) =>
  Math.min(...surfaces.map(s => contrastRatio(rgba(fg), [rgba(hex(theme, s))])!))

const CREAM_INK: Record<string, string> = {
  '--bg-canvas': '#F6F3EE', '--bg-surface': '#FCFAF7', '--bg-surface-hover': '#F3EFEA', '--bg-user-bubble': '#EFEBE6',
  '--ink': '#1C1B19', '--ink-secondary': '#6F6B66', '--ink-tertiary': '#9A958E', '--line': '#E4E0DB', '--line-strong': '#C8C2BA',
  '--cta': '#1C1B19', '--cta-fg': '#F6F3EE', '--focus': '#1C1B19', '--focus-outer': 'rgba(28,27,25,0.20)',
  '--danger': '#A63D2F', '--success': '#3F6B4F', '--shadow': '0 1px 2px rgba(28,27,25,0.06), 0 8px 24px rgba(28,27,25,0.06)',
}
const ALIASES: Record<string, string> = {
  '--canvas-bg': '--bg-canvas', '--sidebar-bg': '--bg-surface', '--panel-bg': '--bg-surface',
  '--widget-bg': '--bg-surface', '--editor-bg': '--bg-surface', '--input-bg': '--bg-surface', '--hover-bg': '--bg-surface-hover',
  '--selected-soft': '--bg-surface-hover', '--bubble-bg': '--bg-user-bubble', '--fg': '--ink', '--fg-strong': '--ink', '--fg-dim': '--ink-secondary',
  '--fg-faint': '--ink-tertiary', '--border': '--line', '--input-border': '--line-strong', '--accent': '--cta', '--button-bg': '--cta',
  '--button-fg': '--cta-fg', '--selected-bg': '--cta', '--selected-fg': '--cta-fg', '--accent-blue': '--ink', '--focus-ring': '--focus',
  '--shadow-card': '--shadow', '--shadow-float': '--shadow', '--shadow-sheet': '--shadow', '--clay': '--danger', '--ok': '--success',
}
const channels = (h: string) => rgba(h).slice(0, 3)
const toHex = (c: number[]) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')

describe('design tokens', () => {
  it('text tokens meet 4.5:1 on their surfaces', () => {
    for (const fg of ['--fg', '--fg-dim', '--fg-faint']) expect(minContrast('dark', hex('dark', fg)), `dark ${fg}`).toBeGreaterThanOrEqual(4.5)
    expect(minContrast('light', hex('light', '--fg')), 'light body').toBeGreaterThanOrEqual(4.5)
    expect(minContrast('light', hex('light', '--fg-dim'), ['--bg-canvas', '--bg-surface', '--bg-surface-hover']), 'light secondary').toBeGreaterThanOrEqual(4.5)
    expect(minContrast('light', hex('light', '--fg-faint'), ['--bg-canvas', '--bg-surface']), 'light tertiary is meta only').toBeGreaterThanOrEqual(2.5)
  })

  it('light theme is the cream+ink table 1:1 with aliases mapped onto it', () => {
    for (const [name, value] of Object.entries(CREAM_INK)) expect(raw('light', name), name).toBe(value)
    for (const [name, target] of Object.entries(ALIASES)) expect(raw('light', name), name).toBe(`var(${target})`)
    expect([hex('light', '--app-bg'), hex('light', '--rail-bg')]).toEqual([hex('light', '--bg-canvas'), hex('light', '--bg-surface')])
    expect(raw('light', '--sidebar-tint')).toBe('none')
    expect(hex('light', '--cta')).not.toBe(hex('light', '--bg-user-bubble'))
    expect(THEMES.light).not.toMatch(/#2563eb|#3b82f6|#007aff/i)
    expect(css).toMatch(/\.bots-write \.chat-send-btn[^{]*\{[^}]*background: var\(--cta/)
    expect(css).toMatch(/\.chat-write-footer \{[^}]*gap: 8px;/)
    expect(css).toContain("[data-theme='light'] ::selection { background: var(--ink);")
  })

  it('tokens have the plan values', () => {
    const plan: Record<Theme, Record<string, string>> = {
      light: { '--rail-bg': '#fcfaf7', '--bubble-bg': '#efebe6', '--selected-soft': '#f3efea', '--fg': '#1c1b19', '--fg-dim': '#6f6b66', '--accent-blue': '#1c1b19', '--app-bg': '#f6f3ee' },
      dark: { '--rail-bg': '#171717', '--bubble-bg': '#2a2a2a', '--selected-soft': '#2f2f2f', '--fg': '#ececec', '--fg-dim': '#b0b0b0', '--accent-blue': '#4b8df8', '--app-bg': '#1c1c1c' },
    }
    for (const theme of ['light', 'dark'] as const) {
      for (const [name, value] of Object.entries(plan[theme])) expect(hex(theme, name), `${theme} ${name}`).toBe(value)
    }

    const [dr, dg, db] = channels(hex('dark', '--fg-faint'))
    expect([dg, db]).toEqual([dr, dr])
    expect(dr).toBeGreaterThanOrEqual(0x94)
    expect(minContrast('dark', toHex([dr! - 1, dg! - 1, db! - 1]))).toBeLessThan(4.5)

    const root = block(':root')
    for (const decl of ['--composer-width: 960px', '--bubble-max: 560px', '--info-pane-width: 320px', '--fs-meta: 13px', '--lh-chat: 22px', '--radius-bubble: 18px', '--radius-row: 10px', '--radius-menu: 12px', '--radius-toast: 18px', '--radius-pill: 999px', '--radius-badge: 6px']) {
      expect(root, decl).toContain(`${decl};`)
    }
    expect(block('.shell')).toContain('--sidebar-width: 240px;')
    expect(block('.app-sidebar.open')).toContain('width: var(--sidebar-width); min-width: var(--sidebar-width);')
    expect(chat).toMatch(/\.bubble-msg\.assistant,\n[^\n]*\{[^}]*line-height: var\(--lh-chat\);/)
  })
})
