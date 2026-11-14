import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as core from 'core/src/bot-character'
import { avatarCharacter, CHARACTERS, defaultCharacter, FALLBACK_CHARACTER, fnv1a, OPT_MAX_PX, ORBS } from '../src/renderer/src/lib/botAvatar.js'
import { BotAvatar, type BotAvatarProps } from '../src/renderer/src/components/BotAvatar.js'

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

  it('is static below 24px, idle at 24px and above, and working only while the bot works', () => {
    expect(OPT_MAX_PX).toBe(24)
    for (const size of SIZES) {
      for (const state of ['idle', 'working', 'attention'] as const) {
        const motion = size < 24 ? 'static' : state === 'working' ? 'working' : 'idle'
        expect(render({ override: { character: '04-lobe' }, size, state })).toContain(`data-orb="orb-green" data-motion="${motion}"`)
      }
    }
  })

  it('is self-contained and cheap', () => {
    for (const size of SIZES) {
      const html = render({ size, state: 'attention', primary: true })
      expect(html).not.toMatch(/<img|<image|url\(|<foreignObject|<text/)
      expect(html.match(/<svg /g)).toHaveLength(3)
      expect(html.match(/<path /g)).toHaveLength(3)
    }
    const batch = () => {
      for (let i = 0; i < 50; i++) for (const size of SIZES) render({ id: `bot-perf-${i}`, size })
    }
    batch()
    const times = [0, 1, 2].map(() => { const t = performance.now(); batch(); return performance.now() - t })
    // Shared CI runners (notably macos-26-intel) are several times slower than a dev Mac; the budget guards against regressions, not runner speed.
    expect(Math.min(...times)).toBeLessThan(process.env['CI'] ? 300 : 50)
  })

  it('keeps motion css transform and opacity only, slow, scoped to idle or working, pausable, with no per-frame script', () => {
    const avatar = readFileSync(join(SRC, 'bot-avatar.css'), 'utf8')
    const orb = readFileSync(join(SRC, 'bot-orb.css'), 'utf8')
    expect(avatar.startsWith("@import './bot-orb.css';")).toBe(true)
    const css = orb + avatar
    const keyframes = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\n\}/g)]
    expect(keyframes).toHaveLength(5)
    for (const [, body] of keyframes) {
      const props = [...body!.matchAll(/\{\s*([^}]*)\}/g)].flatMap(m => [...m[1]!.matchAll(/(?:^|;)\s*([\w-]+)\s*:/g)].map(p => p[1]!))
      expect(props.length).toBeGreaterThan(0)
      for (const prop of props) expect(['transform', 'opacity']).toContain(prop)
    }
    const animated = blocks(css).filter(block => /animation(-name)?\s*:(?! none)/.test(block.body))
    expect(animated.length).toBeGreaterThanOrEqual(5)
    for (const { selector, body } of animated) {
      expect(selector).toMatch(/^\.bot-orb\[data-motion='(idle|working)'\] /)
      const seconds = Number(/animation:\s*[\w-]+ (\d+(?:\.\d+)?)s ease-in-out infinite/.exec(body)?.[1])
      expect(seconds).toBeGreaterThanOrEqual(8)
      expect(seconds).toBeLessThanOrEqual(12)
    }
    expect(css).not.toMatch(/data-motion='static'/)
    expect(css).not.toMatch(/mix-blend-mode|transition\s*:/)
    for (const sheet of [avatar, orb]) {
      expect(sheet).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.bot-(avatar|orb)[^{]*\{ animation: none !important; \}/)
      expect(sheet).toMatch(/:root:not\(\[data-window-focused='true'\]\) \.bot-(avatar|orb)[^{]*\{ animation-play-state: paused; \}/)
    }
    expect(avatar).not.toMatch(/#2F6FEB|#4C86F0|blue/i)
    const orbSource = readFileSync(join(SRC, 'components/BotOrb.tsx'), 'utf8')
    expect(orbSource).not.toMatch(/\buse[A-Z]|requestAnimationFrame|setInterval|setTimeout/)
    expect(readFileSync(join(SRC, 'components/BotAvatar.tsx'), 'utf8')).not.toMatch(/requestAnimationFrame|setInterval|setTimeout/)
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
