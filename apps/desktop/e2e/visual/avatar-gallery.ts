import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CHARACTERS } from '../../../../packages/core/src/bot-character.js'

const DESKTOP = fileURLToPath(new URL('../../', import.meta.url))
const AVATAR = fileURLToPath(new URL('../../src/renderer/src/components/BotAvatar.tsx', import.meta.url))
const ART = fileURLToPath(new URL('../../src/renderer/src/lib/botAvatarParts.ts', import.meta.url))
const CSS_DIR = new URL('../../src/renderer/src/', import.meta.url)
const SIZES = [20, 24, 32, 36, 48, 64, 96] as const
const STATES = ['idle', 'working', 'attention'] as const
type Theme = 'light' | 'dark'
type Cell = { id: string; override?: unknown; primary: boolean; size: number; state: string }
type Render = (props: Cell & { theme: Theme }) => string

let renderer: Promise<Render> | null = null

async function load(): Promise<Render> {
  const entry = `import { createElement } from 'react'\nimport { renderToStaticMarkup } from 'react-dom/server'\nimport { BotAvatar } from ${JSON.stringify(AVATAR)}\nexport const render = props => renderToStaticMarkup(createElement(BotAvatar, props))\n`
  const out = await build({
    stdin: { contents: entry, resolveDir: DESKTOP, loader: 'tsx' }, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', write: false, logLevel: 'silent',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(ART).href) },
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(AVATAR)});` },
  })
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0]!.text).toString('base64')}`) as { render: Render }
  return mod.render
}

// A page set from a string cannot load file URLs, so each master is inlined.
async function inline(html: string): Promise<string> {
  const urls = [...new Set(html.match(/file:\/\/[^"]+\.png/g) ?? [])]
  for (const url of urls) html = html.replaceAll(url, `data:image/png;base64,${(await readFile(new URL(url))).toString('base64')}`)
  return html
}

export function galleryCells(): Cell[] {
  const cells: Cell[] = []
  for (const size of SIZES) for (const state of STATES) {
    cells.push({ id: 'gallery-primary', primary: true, size, state })
    for (const character of CHARACTERS.slice(0, 4)) cells.push({ id: `gallery-${character}`, override: { character }, primary: false, size, state })
  }
  for (const character of CHARACTERS) cells.push({ id: `gallery-${character}`, override: { character }, primary: false, size: 36, state: 'idle' })
  return cells
}

export async function railBg(theme: Theme): Promise<string> {
  const css = await readFile(new URL('styles.css', CSS_DIR), 'utf8')
  const start = css.indexOf(`[data-theme='${theme}'] {`)
  if (start < 0) throw new Error(`styles.css has no [data-theme='${theme}'] block`)
  const block = css.slice(start, css.indexOf('}', start))
  const value = /--rail-bg:\s*([^;]+);/.exec(block)?.[1]?.trim()
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--rail-bg for ${theme} is not #rrggbb: ${value}`)
  return value
}

export async function galleryHtml(theme: Theme): Promise<string> {
  renderer ??= load()
  const render = await renderer
  const css = await readFile(new URL('bot-avatar.css', CSS_DIR), 'utf8')
  const cells = galleryCells().map(cell => `<div class="gallery-cell" data-size="${cell.size}" data-state="${cell.state}" data-primary="${cell.primary}">${render({ ...cell, theme })}</div>`)
  const page = `body { margin: 0; padding: 8px; background: ${await railBg(theme)}; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 6px; }
.gallery-cell { display: flex; align-items: center; justify-content: center; }`
  return inline(`<!doctype html><html data-theme="${theme}" data-window-focused="true"><head><meta charset="utf-8"><style>${css}\n${page}</style></head><body>${cells.join('')}</body></html>`)
}

// The 16 curated faces at every displayed size, one row per size, then the sidebar strip at 24px.
export async function artGalleryHtml(theme: Theme): Promise<string> {
  renderer ??= load()
  const render = await renderer
  const css = await readFile(new URL('bot-avatar.css', CSS_DIR), 'utf8')
  const cell = (character: string, size: number, primary = false) =>
    `<div class="art-cell" data-size="${size}" data-character="${character}">${render({ id: `art-${character}`, override: { character }, primary, size, state: 'idle', theme })}</div>`
  const rows = SIZES.map(size => `<div class="art-row">${CHARACTERS.map(character => cell(character, size)).join('')}</div>`)
  const strip = CHARACTERS.slice(0, 6).map(character => `<div class="art-strip-row">${cell(character, 24)}<span>${character}</span></div>`)
  const sidebar = `<div class="art-strip"><div class="art-strip-hero">${cell('07-oval', 64, true)}<span>Primary</span></div>${strip.join('')}</div>`
  const color = theme === 'dark' ? '#e6e6e6' : '#1c1b19'
  const page = `body { margin: 0; padding: 12px; background: ${await railBg(theme)}; color: ${color}; font: 14px -apple-system, sans-serif; display: flex; gap: 24px; align-items: flex-start; }
.art-rows { display: flex; flex-direction: column; gap: 12px; }
.art-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.art-cell { display: flex; align-items: center; justify-content: center; }
.art-strip { width: 240px; display: flex; flex-direction: column; gap: 14px; padding: 12px; box-sizing: border-box; }
.art-strip-hero { display: flex; flex-direction: column; align-items: center; gap: 6px; margin-bottom: 8px; }
.art-strip-row { display: flex; align-items: center; gap: 12px; }`
  return inline(`<!doctype html><html data-theme="${theme}" data-window-focused="true"><head><meta charset="utf-8"><style>${css}\n${page}</style></head><body><div class="art-rows">${rows.join('')}</div>${sidebar}</body></html>`)
}
