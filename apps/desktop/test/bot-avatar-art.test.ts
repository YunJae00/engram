import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import * as core from 'core/src/bot-character'
import { avatarCharacter, CHARACTERS, defaultCharacter, FALLBACK_CHARACTER, fnv1a, ORBS, RIPPLE_MIN_PX, SMALL_MAX_PX } from '../src/renderer/src/lib/botAvatar.js'
import { BotAvatar, type BotAvatarProps } from '../src/renderer/src/components/BotAvatar.js'
import { BotOrb, ripple } from '../src/renderer/src/components/BotOrb.js'
import { ORB_LOOP_MS, ORB_WAVE_LAYERS, ORB_WORK_LAYERS, orbPaths } from '../src/renderer/src/lib/orbWave.js'

const SRC = join(__dirname, '../src/renderer/src')
const SIZES = [20, 24, 32, 36, 48, 64, 96] as const

type Props = Partial<BotAvatarProps> & { id?: string }
const render = (props: Props = {}) =>
  renderToStaticMarkup(createElement(BotAvatar, { id: 'bot-x', size: 64, state: 'idle', theme: 'light', ...props }))
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(ts|tsx|css)$/.test(entry.name) ? [join(dir, entry.name)] : [])
const blocks = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1]!.trim(), body: m[2]! }))

describe('bot avatar', () => {
  it('reuses the one core hash and catalog; deterministic per id; fails closed on invalid overrides', () => {
    expect(fnv1a).toBe(core.fnv1a)
    expect(CHARACTERS).toBe(core.CHARACTERS)
    expect(ORBS).toBe(core.ORBS)
    expect(defaultCharacter).toBe(core.defaultCharacter)
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(render({ id: 'bot-a' })).toBe(render({ id: 'bot-a' }))
    const counts = new Map<string, number>()
    for (let i = 0; i < 800; i++) {
      const face = avatarCharacter(`bot-test-${i}`)
      counts.set(face, (counts.get(face) ?? 0) + 1)
    }
    expect(counts.size).toBe(8)
    for (const n of counts.values()) expect(n).toBeGreaterThan(50)
    const generated = avatarCharacter('bot-a')
    for (const legacy of [undefined, { body: 1, face: 2, accessory: 3, palette: 4 }, { image: 'a.png' }, null, [], 'x']) expect(avatarCharacter('bot-a', legacy)).toBe(generated)
    for (const bad of [{ character: 'evil/../x' }, { character: 4 }, { character: '02-cloud', image: 'a.png' }]) expect(avatarCharacter('bot-a', bad)).toBe(FALLBACK_CHARACTER)
    CHARACTERS.forEach((legacy, i) => expect(avatarCharacter('bot-a', { character: legacy })).toBe(ORBS[i % 8]))
    expect(avatarCharacter('', undefined)).toBe(FALLBACK_CHARACTER)
  })

  it('maps every orb id to a color rule and never builds a path or ships a character file from stored text', () => {
    const css = readFileSync(join(SRC, 'bot-orb.css'), 'utf8')
    const colors = ORBS.map(id => new RegExp(`\\.bot-orb\\[data-orb='${id}'\\] \\{ --orb: (#[0-9A-F]{6}); \\}`).exec(css)?.[1])
    expect(new Set(colors).size).toBe(8)
    expect(colors).not.toContain(undefined)
    const hostile = render({ override: { character: '../../etc/passwd' } })
    expect(hostile).toContain('data-character="orb-violet"')
    expect(hostile).not.toContain('passwd')
    for (const file of sources(SRC)) expect(readFileSync(file, 'utf8'), file).not.toMatch(/engram-chars|botAvatarParts|characterSrc/)
  })

  it('matches the committed snapshot markup', () => {
    for (const orb of ORBS) expect(render({ id: 'bot-snap', override: { character: orb } })).toMatchSnapshot(orb)
    for (const size of SIZES) expect(render({ id: 'bot-snap', size })).toMatchSnapshot(`size-${size}`)
    for (const state of ['idle', 'working', 'attention'] as const) expect(render({ id: 'bot-snap', state, primary: true })).toMatchSnapshot(`state-${state}`)
  })

  it('is the small still master up to 32px, breathes under 64px, ripples from 64px, and shows working at every size', () => {
    expect([SMALL_MAX_PX, RIPPLE_MIN_PX]).toEqual([32, 64])
    for (const size of SIZES) {
      for (const state of ['idle', 'working', 'attention'] as const) {
        const motion = state === 'working' ? 'working' : size <= 32 ? 'static' : 'idle'
        const html = render({ override: { character: '04-lobe' }, size, state })
        expect(html).toContain(`data-orb="orb-green" data-motion="${motion}" data-master="${size <= 32 ? 'small' : 'full'}"`)
        // The ripple is redrawn per frame only from 64px; a small working orb shows its work with css alone.
        expect(html.includes('data-ripple="true"'), `${size} ${state}`).toBe(size >= 64)
      }
    }
    // An orb with no size given (the team tree's 16px orb) is the small master.
    const bare = renderToStaticMarkup(createElement(BotOrb, { orb: 'orb-teal', motion: 'static' }))
    expect(bare).toContain('data-orb="orb-teal" data-motion="static" data-master="small"')
    expect(bare).not.toContain('data-ripple')
  })

  it('draws all 8 colors from one silhouette: the core stays white and silver is untinted', () => {
    const css = readFileSync(join(SRC, 'bot-orb.css'), 'utf8')
    const shapes = new Set(ORBS.map(orb => render({ override: { character: orb } }).replaceAll(orb, 'orb')))
    expect(shapes.size).toBe(1)
    expect(css).toMatch(/\.bot-orb-core \{ fill: #FFFFFF;/)
    expect(css).toMatch(/\.bot-orb-work-core \{ fill: #FFFFFF;/)
    for (const part of ['shade', 'mist', 'floor', 'warm', 'cool', 'warm-haze', 'cool-haze', 'rim', 'caustic']) expect(css, part).toMatch(new RegExp(`--${part}: color-mix\\([^;]*var\\(--orb\\) var\\(--tint-(rim|glow|mist)\\)`))
    expect(css).toContain(".bot-orb[data-orb='orb-silver'] { --tint-rim: 0%; --tint-glow: 0%; --tint-mist: 0%; }")
    expect(css.match(/--tint-rim: 0%/g)).toHaveLength(1)
    // The ball is the same on a light and a dark surface.
    expect(css).not.toMatch(/data-theme/)
  })

  it('builds the wave as closed ribbons: a seamless 12s loop, a plainer and thicker small master, a working core about 55% thicker', () => {
    expect(ORB_LOOP_MS).toBe(12000)
    const layers = [...ORB_WAVE_LAYERS, ...ORB_WORK_LAYERS]
    expect(layers).toEqual(['shade', 'warm-haze', 'cool-haze', 'warm', 'cool', 'core', 'work-warm', 'work-cool', 'work-core'])
    for (const master of ['full', 'small'] as const) {
      const still = orbPaths(master, 0)
      expect(still).toHaveLength(layers.length)
      for (const d of still) expect(d).toMatch(/^M-?\d+(\.\d+)? -?\d+(\.\d+)?(L-?\d+(\.\d+)? -?\d+(\.\d+)?)+Z$/)
      expect(orbPaths(master, 1)).toEqual(still)
      expect(orbPaths(master, 0.5)).not.toEqual(still)
      expect(orbPaths(master, 0.25)).not.toEqual(orbPaths(master, 0.75))
    }
    // Thickness of a ribbon at the middle of the ball: its first half runs left to right along the top edge, its second half back along the bottom.
    const thick = (d: string) => {
      const ys = d.slice(1, -1).split('L').map(point => Number(point.split(' ')[1]))
      const mid = Math.floor(ys.length / 4)
      return ys[ys.length - 1 - mid]! - ys[mid]!
    }
    const [full, small] = [orbPaths('full', 0), orbPaths('small', 0)]
    const ratio = thick(full[8]!) / thick(full[5]!)
    expect(ratio).toBeGreaterThan(1.45)
    expect(ratio).toBeLessThan(1.65)
    expect(thick(small[5]!)).toBeGreaterThan(thick(full[5]!) * 2)
    // The haze widens with the work too.
    expect(thick(full[6]!)).toBeGreaterThan(thick(full[1]!) * 1.3)
    // The small master has no hooks: its line is lower at the left glass and higher at the right than the full master's, which runs up and down the glass.
    const edge = (d: string, i: number) => Number(d.slice(1).split('L')[i]!.split(' ')[1])
    expect(edge(small[5]!, 0)).toBeGreaterThan(edge(full[5]!, 0))
    expect(edge(small[5]!, 40)).toBeLessThan(edge(full[5]!, 40))
  })

  it('is self-contained and cheap', () => {
    for (const size of SIZES) {
      const html = render({ size, state: 'attention', primary: true })
      expect(html).not.toMatch(/<img|<image|<canvas|url\(|<foreignObject|<text|<filter|<linearGradient|<radialGradient| id=/)
      // Two svgs: the wave (the dark upper half, two hazes, two fringes, the core) and the working overlay (two hazes, a thicker core).
      expect(html.match(/<svg /g)).toHaveLength(2)
      expect(html.match(/<path /g)).toHaveLength(9)
      expect(html).not.toMatch(/<circle |<rect /)
    }
    const batch = () => {
      for (let i = 0; i < 50; i++) for (const size of SIZES) render({ id: `bot-perf-${i}`, size })
    }
    batch()
    const times = [0, 1, 2].map(() => { const t = performance.now(); batch(); return performance.now() - t })
    // Shared CI runners (notably macos-26-intel) are several times slower than a dev Mac; the budget guards against regressions, not runner speed.
    expect(Math.min(...times)).toBeLessThan(process.env['CI'] ? 300 : 50)
    // One frame of the ripple is nine short strings; the shared ticker builds them once for every orb on screen.
    const t = performance.now()
    for (let i = 0; i < 360; i++) orbPaths('full', i / 360)
    expect(performance.now() - t).toBeLessThan(process.env['CI'] ? 1500 : 300)
  })

  it('keeps css motion to transform and opacity, slow, scoped to idle or working, pausable, and still under reduced motion', () => {
    const avatar = readFileSync(join(SRC, 'bot-avatar.css'), 'utf8')
    const orb = readFileSync(join(SRC, 'bot-orb.css'), 'utf8')
    expect(avatar.startsWith("@import './bot-orb.css';")).toBe(true)
    const css = orb + avatar
    const keyframes = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\n\}/g)]
    // The breathe of the light layer under 64px, and the working overlay's pulse.
    expect(keyframes).toHaveLength(2)
    for (const [, body] of keyframes) {
      const props = [...body!.matchAll(/\{\s*([^}]*)\}/g)].flatMap(m => [...m[1]!.matchAll(/(?:^|;)\s*([\w-]+)\s*:/g)].map(p => p[1]!))
      expect(props.length).toBeGreaterThan(0)
      for (const prop of props) expect(['transform', 'opacity']).toContain(prop)
    }
    const animated = blocks(css).filter(block => /animation(-name)?\s*:(?! none)/.test(block.body))
    expect(animated).toHaveLength(2)
    for (const { selector, body } of animated) {
      for (const one of selector.split(',')) expect(one.trim()).toMatch(/^\.bot-orb\[data-motion='(idle|working)'\]/)
      const [, name, time] = /animation:\s*([\w-]+) (\d+(?:\.\d+)?)s ease-in-out infinite/.exec(body) ?? []
      expect(Number(time)).toBe(12)
      // The breathe never runs on the small master or on an orb whose wave the ticker redraws; the pulse belongs to working alone.
      if (name === 'bot-orb-breathe') for (const one of selector.split(',')) expect(one).toMatch(/\[data-master='full'\]:not\(\[data-ripple\]\) \.bot-orb-light$/)
      else expect([name, selector]).toEqual(['bot-orb-pulse', ".bot-orb[data-motion='working'] .bot-orb-work"])
    }
    expect(css).not.toMatch(/data-motion='static'/)
    expect(css).not.toMatch(/mix-blend-mode/)
    // Work begins and ends as one fade of the overlay, not a jump.
    expect(css.match(/transition\s*:[^;]*/g)).toEqual(['transition: opacity 0.9s ease-in-out', 'transition: none !important'])
    expect(orb).toMatch(/\.bot-orb-work \{ opacity: 0; transition: opacity 0\.9s ease-in-out; \}/)
    expect(orb).toMatch(/\.bot-orb\[data-motion='working'\] \.bot-orb-work \{ opacity: 1;/)
    for (const sheet of [avatar, orb]) {
      expect(sheet).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.bot-(avatar|orb)[^{]*\{ animation: none !important;( transition: none !important;)? \}/)
      expect(sheet).toMatch(/:root:not\(\[data-window-focused='true'\]\) \.bot-(avatar|orb)[^{]*\{ animation-play-state: paused( !important)?; \}/)
    }
    // The orb's pause has to beat the more specific breathe rule, whose shorthand sets the play state back to running.
    expect(orb).toMatch(/:root:not\(\[data-window-focused='true'\]\) \.bot-orb \* \{ animation-play-state: paused !important; \}/)
    expect(avatar).not.toMatch(/#2F6FEB|#4C86F0|blue/i)
    // The avatar is the ball alone: a circle that clips its light, with no plate behind it.
    const body = blocks(orb).find(block => block.selector.endsWith('.bot-orb'))!.body
    expect(body).toMatch(/border-radius: 50%; overflow: hidden;/)
    expect([...orb.matchAll(/border-radius:\s*([^;]+);/g)].map(m => m[1])).toEqual(['50%', '50%'])
    expect(orb).not.toMatch(/box-shadow|squircle|plate/)
  })

  it('redraws the wave from one shared, pausable ticker and nowhere else', () => {
    const orbSource = readFileSync(join(SRC, 'components/BotOrb.tsx'), 'utf8')
    // One loop for every orb: it is started from sync() and re-armed from inside itself only while an orb is on screen in a visible, focused window.
    expect(orbSource.match(/requestAnimationFrame\(/g)).toHaveLength(2)
    expect(orbSource).toContain('frame = awake() ? requestAnimationFrame(tick) : 0')
    expect(orbSource).toContain('} else if (frame === 0) frame = requestAnimationFrame(tick)')
    expect(orbSource.match(/new IntersectionObserver\(/g)).toHaveLength(1)
    expect(orbSource).toContain("live.size > 0 && !document.hidden && document.documentElement.dataset['windowFocused'] === 'true'")
    expect(orbSource).toContain("matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 :")
    expect(orbSource).toContain("const rippling = motion !== 'static' && size >= RIPPLE_MIN_PX")
    expect(orbSource).not.toMatch(/setInterval|setTimeout|<canvas|getContext/)
    expect(readFileSync(join(SRC, 'components/BotAvatar.tsx'), 'utf8')).not.toMatch(/requestAnimationFrame|setInterval|setTimeout/)
    expect(readFileSync(join(SRC, 'lib/orbWave.ts'), 'utf8')).not.toMatch(/requestAnimationFrame|setInterval|setTimeout|document|window/)
  })

  it('requests no frame while blurred, hidden or with no orb on screen, and lets go of its observers after the last orb', () => {
    // A hand-driven frame queue, so every requestAnimationFrame call is counted.
    let requested = 0
    let pending = new Map<number, (now: number) => void>()
    const run = (now: number) => { const due = pending; pending = new Map(); for (const callback of due.values()) callback(now) }
    const listeners = new Set<() => void>()
    const root = { dataset: { windowFocused: 'true' } as Record<string, string> }
    const doc = { hidden: false, documentElement: root, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) }
    const observers: { seen: (entries: { target: unknown; isIntersecting: boolean }[]) => void; connected: boolean }[] = []
    const mutations: { changed: () => void; connected: boolean }[] = []
    vi.stubGlobal('document', doc)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => { pending.set(++requested, callback); return requested })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { pending.delete(id) })
    vi.stubGlobal('IntersectionObserver', class { self: (typeof observers)[number]; constructor(seen: (typeof observers)[number]['seen']) { observers.push(this.self = { seen, connected: true }) } observe() {} unobserve() {} disconnect() { this.self.connected = false } })
    vi.stubGlobal('MutationObserver', class { self: (typeof mutations)[number]; constructor(changed: () => void) { mutations.push(this.self = { changed, connected: true }) } observe() {} disconnect() { this.self.connected = false } })
    try {
      const paths = Array.from({ length: ORB_WAVE_LAYERS.length + ORB_WORK_LAYERS.length }, () => ({ d: '', setAttribute(_: string, value: string) { this.d = value } }))
      const orb = { querySelectorAll: () => paths } as unknown as Element
      const frames = (from: number, count: number) => { for (let i = 0; i < count; i++) run(from + i * 40) }
      const focus = (value: boolean) => { root.dataset['windowFocused'] = String(value); mutations.at(-1)!.changed() }
      const visible = (value: boolean) => { doc.hidden = !value; for (const fn of listeners) fn() }

      const stop = ripple(orb)
      // Mounted but not on screen yet: no frame.
      expect([requested, pending.size]).toEqual([0, 0])
      observers[0]!.seen([{ target: orb, isIntersecting: true }])
      expect([requested, pending.size]).toEqual([1, 1])
      frames(1000, 5)
      expect([requested, pending.size]).toEqual([6, 1])
      expect(paths[0]!.d).toBe(orbPaths('full', ((Math.floor(1160 / (1000 / 30)) + 1) * (1000 / 30)) / ORB_LOOP_MS)[0])

      // Blur cancels the pending frame and nothing is requested until focus returns.
      focus(false)
      expect(pending.size).toBe(0)
      const held = paths[0]!.d
      frames(2000, 5)
      expect([requested, pending.size, paths[0]!.d]).toEqual([6, 0, held])
      focus(true)
      expect([requested, pending.size]).toEqual([7, 1])
      frames(3000, 3)
      expect(requested).toBe(10)

      // A hidden document: the same.
      visible(false)
      expect(pending.size).toBe(0)
      frames(4000, 5)
      focus(false)
      focus(true)
      expect([requested, pending.size]).toEqual([10, 0])
      visible(true)
      expect([requested, pending.size]).toEqual([11, 1])

      // Scrolled off screen, then back.
      observers[0]!.seen([{ target: orb, isIntersecting: false }])
      expect(pending.size).toBe(0)
      observers[0]!.seen([{ target: orb, isIntersecting: true }])
      expect([requested, pending.size]).toEqual([12, 1])

      // A second orb shares the loop and the observer; the loop outlives the first orb and ends with the last.
      const other = { querySelectorAll: () => [] } as unknown as Element
      const stopOther = ripple(other)
      observers[0]!.seen([{ target: other, isIntersecting: true }])
      expect([requested, pending.size, observers.length]).toEqual([12, 1, 1])
      stop()
      expect(paths[0]!.d).toBe(orbPaths('full', 0)[0])
      expect([pending.size, observers[0]!.connected, listeners.size]).toEqual([1, true, 1])
      stopOther()
      expect([requested, pending.size]).toEqual([12, 0])
      expect([observers[0]!.connected, mutations[0]!.connected, listeners.size]).toEqual([false, false, 0])
      frames(5000, 5)
      expect(requested).toBe(12)

      // A later orb starts again with a fresh observer.
      const again = ripple(orb)
      expect([observers.length, observers[1]!.connected, listeners.size]).toEqual([2, true, 1])
      again()
      expect([observers[1]!.connected, listeners.size, pending.size]).toEqual([false, 0, 0])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('holds the contract edges: primary keeps its hashed face, no photo is ever shown', () => {
    expect(render({ primary: true })).toContain(`data-character="${avatarCharacter('bot-x')}"`)
    for (const id of ['bot-a', 'bot-b', 'bot-c']) expect(render({ id, primary: true })).toContain(`data-character="${avatarCharacter(id)}"`)
    const photo = render({ override: { image: 'avatars/a.png' }, state: 'attention', primary: true })
    expect(photo).toBe(render({ state: 'attention', primary: true }))
    expect(photo).toContain('class="bot-orb"')
    expect(photo).toContain('bot-avatar-alert')
    expect(photo).toContain('bot-avatar-primary')
    expect(photo).not.toContain('a.png')
  })
})
