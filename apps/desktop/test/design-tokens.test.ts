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

function hex(theme: Theme, name: string): string {
  const found = [...THEMES[theme].matchAll(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'gm'))]
  if (found.length !== 1) throw new Error(`${theme} ${name} declared ${found.length} times`)
  const value = found[0]![1]!.trim()
  if (!/^#[0-9a-f]{6}$/.test(value)) throw new Error(`${theme} ${name} is not #rrggbb: ${value}`)
  return value
}

const rgba = (h: string): Rgba => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 1]
const SURFACES = ['--app-bg', '--rail-bg', '--bubble-bg', '--selected-soft']
const minContrast = (theme: Theme, fg: string) =>
  Math.min(...SURFACES.map(s => contrastRatio(rgba(fg), [rgba(hex(theme, s))])!))
const channels = (h: string) => rgba(h).slice(0, 3)
const toHex = (c: number[]) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')

describe('design tokens', () => {
  it('text tokens meet 4.5:1 and faint meets 4.5:1 on its surfaces in light and dark', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const fg of ['--fg', '--fg-dim', '--fg-faint']) {
        expect(minContrast(theme, hex(theme, fg)), `${theme} ${fg}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('tokens have the plan values', () => {
    const plan: Record<Theme, Record<string, string>> = {
      light: { '--rail-bg': '#f7f7f8', '--bubble-bg': '#f2f2f3', '--selected-soft': '#ebebed', '--fg': '#1d1d1f', '--fg-dim': '#606066', '--accent-blue': '#2563eb', '--app-bg': '#ffffff' },
      dark: { '--rail-bg': '#171717', '--bubble-bg': '#2a2a2a', '--selected-soft': '#2f2f2f', '--fg': '#ececec', '--fg-dim': '#b0b0b0', '--accent-blue': '#4b8df8', '--app-bg': '#1c1c1c' },
    }
    for (const theme of ['light', 'dark'] as const) {
      for (const [name, value] of Object.entries(plan[theme])) expect(hex(theme, name), `${theme} ${name}`).toBe(value)
    }

    const [lr, lg, lb] = channels(hex('light', '--fg-faint'))
    expect(lg).toBe(lr)
    expect(lb).toBe(lr! + 4)
    expect(lr).toBeLessThanOrEqual(0x74)
    expect(minContrast('light', toHex([lr! + 1, lg! + 1, lb! + 1]))).toBeLessThan(4.5)

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
