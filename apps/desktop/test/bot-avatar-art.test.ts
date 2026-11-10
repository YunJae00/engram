import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AVATAR_RANGES as CORE_RANGES } from 'core/src/bot-fields'
import { contrastRatio, type Rgba } from '../e2e/visual/spec.js'
import { AVATAR_RANGES, avatarSpec, CRATERS, fnv1a, PALETTES, PATHS, SUN_PALETTE } from '../src/renderer/src/lib/botAvatar.js'
import { BotAvatar, type BotAvatarProps } from '../src/renderer/src/components/BotAvatar.js'

const SRC = join(__dirname, '../src/renderer/src')
const SIZES = [20, 36, 64, 96] as const
const THEMES = ['light', 'dark'] as const
const BASE = { body: 0, face: 0, accessory: 0, palette: 0 }

type Props = Partial<BotAvatarProps> & { id?: string }
const render = (props: Props = {}) =>
  renderToStaticMarkup(createElement(BotAvatar, { id: 'bot-x', size: 64, state: 'idle', theme: 'light', ...props }))

function elementCount(html: string): number {
  const svg = html.indexOf('<svg')
  const rest = html.slice(html.indexOf('>', svg) + 1)
  return (rest.match(/<[a-zA-Z]/g) ?? []).length
}

describe('bot avatar', () => {
  it('is deterministic per id and fails closed on invalid overrides', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(render({ id: 'bot-a' })).toBe(render({ id: 'bot-a' }))
    render({ id: 'bot-b' })
    expect(render({ id: 'bot-a' })).toBe(render({ id: 'bot-a' }))

    const counts = { body: new Map<unknown, number>(), face: new Map<unknown, number>(), palette: new Map<unknown, number>() }
    for (let i = 0; i < 1000; i++) {
      const spec = avatarSpec(`bot-test-${i}`)
      if (spec.kind !== 'drawn') throw new Error('generated spec must be drawn')
      expect(spec.accessory).toBe(0)
      for (const key of ['body', 'face', 'palette'] as const) counts[key].set(spec[key], (counts[key].get(spec[key]) ?? 0) + 1)
    }
    for (const [key, n] of [['body', 6], ['face', 6], ['palette', 8]] as const) {
      expect(counts[key].size, key).toBe(n)
      for (const hits of counts[key].values()) expect(hits, key).toBeGreaterThanOrEqual(50)
    }

    const primary = avatarSpec('bot-a', undefined, true)
    expect(primary).toMatchObject({ kind: 'drawn', body: 'sun', palette: 'sun', accessory: 0 })
    expect(avatarSpec('bot-a', { body: 2, face: 1, accessory: 3, palette: 4 }, true)).toEqual({ kind: 'drawn', body: 'sun', face: 1, accessory: 3, palette: 4 })

    const generated = avatarSpec('bot-a')
    const invalid: unknown[] = [
      { ...BASE, body: 6 }, { ...BASE, body: 1.5 }, { ...BASE, body: '2' }, { ...BASE, extra: 1 },
      null, [], [0, 0, 0, 0], { body: 0, face: 0, accessory: 0 }, { ...BASE, palette: -1 }, { image: 3 }, { image: 'a', body: 0 },
      Object.defineProperty({ ...BASE }, 'hidden', { value: 1, enumerable: false }),
      new Proxy({}, { ownKeys: () => { throw new Error('boom') } }),
      Object.defineProperty({ face: 0, accessory: 0, palette: 0 }, 'body', { enumerable: true, get: () => { throw new Error('boom') } }),
    ]
    for (const value of invalid) expect(avatarSpec('bot-a', value)).toEqual(generated)

    let reads = 0
    const shifty = Object.defineProperty({ face: 0, accessory: 0, palette: 0 }, 'body', { enumerable: true, get: () => (reads++ === 0 ? 2 : 6) })
    const spec = avatarSpec('bot-a', shifty)
    expect(spec).toEqual({ kind: 'drawn', body: 2, face: 0, accessory: 0, palette: 0 })
    expect(reads).toBe(1)
  })

  it('matches the committed snapshot markup', () => {
    const variants: [string, Props][] = [
      ...[0, 1, 2, 3, 4, 5].map((body): [string, Props] => [`body-${body}`, { override: { ...BASE, body } }]),
      ['body-sun', { primary: true }],
      ...[0, 1, 2, 3, 4, 5].map((face): [string, Props] => [`face-${face}`, { override: { ...BASE, face } }]),
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((accessory): [string, Props] => [`accessory-${accessory}`, { override: { ...BASE, accessory } }]),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((palette): [string, Props] => [`palette-${palette}`, { override: { ...BASE, palette } }]),
    ]
    expect(variants).toHaveLength(30)
    for (const [name, props] of variants) {
      for (const size of SIZES) {
        for (const theme of THEMES) expect(render({ id: 'bot-snap', size, theme, ...props })).toMatchSnapshot(`${name} ${size} ${theme}`)
      }
    }
    for (const state of ['idle', 'working', 'attention'] as const) {
      for (const size of SIZES) expect(render({ id: 'bot-snap', override: BASE, size, state })).toMatchSnapshot(`state-${state} ${size}`)
    }
  })

  it('meets contrast against the theme surfaces', () => {
    const css = readFileSync(join(SRC, 'styles.css'), 'utf8')
    const block = (theme: string) => {
      const start = css.indexOf(`[data-theme='${theme}'] {`)
      if (start < 0) throw new Error(`missing ${theme} block`)
      return css.slice(start, css.indexOf('\n}', start))
    }
    const hex = (theme: string, name: string) => {
      const found = [...block(theme).matchAll(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'gm'))]
      if (found.length !== 1) throw new Error(`${theme} ${name} declared ${found.length} times`)
      const value = found[0]![1]!.trim()
      if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${theme} ${name} is not #rrggbb: ${value}`)
      return value
    }
    const rgba = (h: string): Rgba => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 1]
    const ratio = (fg: string, bg: string) => contrastRatio(rgba(fg), [rgba(bg)])!
    for (const palette of [...PALETTES, SUN_PALETTE]) {
      for (const theme of THEMES) {
        expect(ratio(palette.ink, palette[theme].fill), `${palette.ink} on ${palette[theme].fill}`).toBeGreaterThanOrEqual(4.5)
        for (const surface of ['--app-bg', '--rail-bg']) {
          expect(ratio(palette[theme].line, hex(theme, surface)), `${theme} ${palette[theme].line} on ${surface}`).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })

  it('is self-contained and cheap', () => {
    expect(AVATAR_RANGES).toEqual(CORE_RANGES)
    const budget = { 20: 12, 36: 24, 64: 40, 96: 40 }
    for (const theme of THEMES) {
      for (const size of SIZES) {
        for (const part of ['body', 'face', 'accessory', 'palette'] as const) {
          for (let n = 0; n <= AVATAR_RANGES[part]; n++) {
            for (const primary of [false, true]) {
              const html = render({ override: { ...BASE, [part]: n }, size, theme, state: 'attention', primary })
              expect(html).not.toMatch(/<image|href|url\(|<foreignObject|<text/)
              expect(elementCount(html), `${part}-${n} ${size} ${primary}`).toBeLessThanOrEqual(budget[size])
            }
          }
        }
      }
    }
    const small = (body: number) => render({ override: { ...BASE, body }, size: 20 })
    expect(small(0)).not.toContain(PATHS.planetShade)
    expect(small(3)).not.toContain(`cx="${CRATERS[0][0]}"`)
    expect(small(1)).not.toContain(PATHS.ringFront)
    expect(small(0)).not.toContain('<path')
    expect(render({ override: { ...BASE, body: 0 }, size: 36 })).toContain(PATHS.planetShade)

    const batch = () => {
      for (let i = 0; i < 50; i++) for (const size of SIZES) render({ id: `bot-perf-${i}`, size })
    }
    batch()
    const times = [0, 1, 2].map(() => { const t = performance.now(); batch(); return performance.now() - t })
    expect(Math.min(...times)).toBeLessThan(50)
  })

  it('keeps motion css transform-only and pausable', () => {
    const css = readFileSync(join(SRC, 'bot-avatar.css'), 'utf8')
    const keyframes = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\n\}/g)]
    expect(keyframes.length).toBeGreaterThan(0)
    for (const [, body] of keyframes) {
      const props = [...body!.matchAll(/([\w-]+)\s*:/g)].map(m => m[1])
      expect(new Set(props)).toEqual(new Set(['transform']))
    }
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.bot-avatar[^{]*\{ animation: none[^}]*\}/)
    expect(css).toMatch(/:root:not\(\[data-window-focused='true'\]\) \.bot-avatar[^{]*\{ animation-play-state: paused; \}/)
    const html = render()
    expect(html).toMatch(/^<span class="bot-avatar" data-size="64" data-state="idle" aria-hidden="true">/)
  })

  it('holds the contract edges', () => {
    const image = avatarSpec('bot-x', { image: 'avatars/a.png' })
    expect(image).toStrictEqual({ kind: 'image', image: 'avatars/a.png' })
    expect(Reflect.ownKeys(image)).toEqual(['kind', 'image'])
    expect(Reflect.ownKeys(avatarSpec('bot-x', { image: 'a.png' }, true))).toEqual(['kind', 'image'])
    expect(Reflect.ownKeys(avatarSpec('bot-x'))).toEqual(['kind', 'body', 'face', 'accessory', 'palette'])
    expect(Reflect.ownKeys(avatarSpec('bot-x', BASE, true))).toEqual(['kind', 'body', 'face', 'accessory', 'palette'])

    const sun = render({ primary: true, override: { body: 1, face: 2, accessory: 3, palette: 4 } })
    expect(sun).toBe(render({ primary: true, override: { body: 3, face: 2, accessory: 3, palette: 4 } }))
    expect(sun).not.toBe(render({ primary: false, override: { body: 1, face: 2, accessory: 3, palette: 4 } }))
    expect(sun).toContain(PATHS.sunRays)

    for (const theme of THEMES) {
      const generated = render({ size: 64, theme })
      expect(render({ size: 64, theme, override: { image: 'a.png' } })).toBe(generated)
      expect(render({ size: 64, theme, override: { image: 'b.png' } })).toBe(generated)
      expect(render({ size: 64, theme, override: { image: 'a.png' }, imageUrl: '' })).toBe(generated)
      expect(render({ size: 64, theme, primary: true, override: { image: 'a.png' } })).toBe(render({ size: 64, theme, primary: true }))
    }
    const withUrl = render({ override: { image: 'a.png' }, imageUrl: 'blob:x', state: 'attention', primary: true })
    expect(withUrl).toContain('<img')
    expect(withUrl).toContain('alt=""')
    expect(withUrl).toContain('src="blob:x"')
    expect(withUrl).toContain('bot-avatar-alert')
    expect(withUrl).toContain('bot-avatar-primary')
    expect(withUrl).not.toContain('a.png')
  })
})
