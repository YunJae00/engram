import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as core from 'core/src/bot-character'
import { avatarCharacter, CHARACTERS, characterSrc, defaultCharacter, FALLBACK_CHARACTER, fnv1a, OPT_MAX_PX } from '../src/renderer/src/lib/botAvatar.js'
import { CHARACTER_ART } from '../src/renderer/src/lib/botAvatarParts.js'
import { BotAvatar, type BotAvatarProps } from '../src/renderer/src/components/BotAvatar.js'

const SRC = join(__dirname, '../src/renderer/src')
const ASSETS = join(SRC, 'assets/engram-chars')
const SIZES = [20, 24, 32, 36, 48, 64, 96] as const

type Props = Partial<BotAvatarProps> & { id?: string }
const render = (props: Props = {}) =>
  renderToStaticMarkup(createElement(BotAvatar, { id: 'bot-x', size: 64, state: 'idle', theme: 'light', ...props }))
// Asset URLs are absolute on disk under vitest; the snapshot keeps only the file name.
const portable = (html: string) => html.replace(/src="[^"]*\/([^/"]+\.png)"/g, 'src="$1"')

describe('bot avatar', () => {
  it('reuses the one core hash and catalog; deterministic per id; fails closed on invalid overrides', () => {
    expect(fnv1a).toBe(core.fnv1a)
    expect(CHARACTERS).toBe(core.CHARACTERS)
    expect(defaultCharacter).toBe(core.defaultCharacter)
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(render({ id: 'bot-a' })).toBe(render({ id: 'bot-a' }))
    const counts = new Map<string, number>()
    for (let i = 0; i < 1600; i++) {
      const face = avatarCharacter(`bot-test-${i}`)
      counts.set(face, (counts.get(face) ?? 0) + 1)
    }
    expect(counts.size).toBe(16)
    for (const n of counts.values()) expect(n).toBeGreaterThan(50)
    const generated = avatarCharacter('bot-a')
    for (const legacy of [undefined, { body: 1, face: 2, accessory: 3, palette: 4 }, { image: 'a.png' }, null, [], 'x']) expect(avatarCharacter('bot-a', legacy)).toBe(generated)
    for (const bad of [{ character: 'evil/../x' }, { character: 4 }, { character: '02-cloud', image: 'a.png' }]) expect(avatarCharacter('bot-a', bad)).toBe(FALLBACK_CHARACTER)
    expect(avatarCharacter('', undefined)).toBe(FALLBACK_CHARACTER)
  })

  it('maps every id to its shipped normal and @opt file and never builds a path from stored text', () => {
    const files = readdirSync(ASSETS).sort()
    expect(files).toEqual(CHARACTERS.flatMap(id => [`${id}.png`, `${id}@opt.png`]).sort())
    expect(Object.keys(CHARACTER_ART)).toEqual([...CHARACTERS])
    for (const id of CHARACTERS) {
      const art = CHARACTER_ART[id]
      expect(art.full.endsWith(`/${id}.png`)).toBe(true)
      expect(art.opt.endsWith(`/${id}@opt.png`)).toBe(true)
      expect(existsSync(fileURLToPath(art.full)) && existsSync(fileURLToPath(art.opt))).toBe(true)
      expect(characterSrc(id, OPT_MAX_PX)).toBe(art.opt)
      expect(characterSrc(id, OPT_MAX_PX + 1)).toBe(art.full)
    }
    expect(OPT_MAX_PX).toBe(24)
    expect(characterSrc('nope' as never, 20)).toBe(CHARACTER_ART[FALLBACK_CHARACTER].opt)
    expect(render({ override: { character: '../../etc/passwd' } })).toContain('07-oval.png')
  })

  it('matches the committed snapshot markup', () => {
    for (const character of CHARACTERS) expect(portable(render({ id: 'bot-snap', override: { character } }))).toMatchSnapshot(character)
    for (const size of SIZES) expect(portable(render({ id: 'bot-snap', size }))).toMatchSnapshot(`size-${size}`)
    for (const state of ['idle', 'working', 'attention'] as const) expect(portable(render({ id: 'bot-snap', state, primary: true }))).toMatchSnapshot(`state-${state}`)
  })

  it('uses @opt at 24px and below and the normal master above', () => {
    for (const size of SIZES) {
      const html = render({ override: { character: '04-lobe' }, size })
      expect(html).toContain(size <= 24 ? '04-lobe@opt.png' : '04-lobe.png')
      if (size > 24) expect(html).not.toContain('@opt')
    }
  })

  it('is self-contained and cheap', () => {
    for (const size of SIZES) {
      const html = render({ size, state: 'attention', primary: true })
      expect(html).not.toMatch(/<svg|<image|url\(|<foreignObject|<text/)
      expect(html.match(/<img /g)).toHaveLength(1)
    }
    const batch = () => {
      for (let i = 0; i < 50; i++) for (const size of SIZES) render({ id: `bot-perf-${i}`, size })
    }
    batch()
    const times = [0, 1, 2].map(() => { const t = performance.now(); batch(); return performance.now() - t })
    // Shared CI runners (notably macos-26-intel) are several times slower than a dev Mac; the budget guards against regressions, not runner speed.
    expect(Math.min(...times)).toBeLessThan(process.env['CI'] ? 300 : 50)
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
    expect(css).toContain('object-fit: contain')
    expect(css).not.toMatch(/#2F6FEB|#4C86F0|blue/i)
  })

  it('holds the contract edges: primary keeps its hashed face, no photo is ever shown', () => {
    expect(render({ primary: true })).toContain(`data-character="${avatarCharacter('bot-x')}"`)
    for (const id of ['bot-a', 'bot-b', 'bot-c']) expect(render({ id, primary: true })).toContain(`data-character="${avatarCharacter(id)}"`)
    const photo = render({ override: { image: 'avatars/a.png' }, state: 'attention', primary: true })
    expect(photo).toBe(render({ state: 'attention', primary: true }))
    expect(photo).toContain('alt=""')
    expect(photo).toContain('bot-avatar-alert')
    expect(photo).toContain('bot-avatar-primary')
    expect(photo).not.toContain('a.png')
  })
})
