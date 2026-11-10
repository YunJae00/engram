import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const DESKTOP = fileURLToPath(new URL('../../', import.meta.url))
const AVATAR = fileURLToPath(new URL('../../src/renderer/src/components/BotAvatar.tsx', import.meta.url))
const CSS_DIR = new URL('../../src/renderer/src/', import.meta.url)
const SIZES = [20, 36, 64, 96] as const
const STATES = ['idle', 'working', 'attention'] as const
type Theme = 'light' | 'dark'
type Cell = { id: string; override?: unknown; primary: boolean; size: number; state: string }
type Render = (props: Cell & { theme: Theme }) => string

let renderer: Promise<Render> | null = null

async function load(): Promise<Render> {
  const entry = `import { createElement } from 'react'\nimport { renderToStaticMarkup } from 'react-dom/server'\nimport { BotAvatar } from ${JSON.stringify(AVATAR)}\nexport const render = props => renderToStaticMarkup(createElement(BotAvatar, props))\n`
  const out = await build({
    stdin: { contents: entry, resolveDir: DESKTOP, loader: 'tsx' }, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', write: false, logLevel: 'silent',
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(AVATAR)});` },
  })
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0]!.text).toString('base64')}`) as { render: Render }
  return mod.render
}

export function galleryCells(): Cell[] {
  const cells: Cell[] = []
  for (const size of SIZES) for (const kind of [0, 1, 2, 3, 4, 5, 'primary'] as const) for (const state of STATES) {
    cells.push(kind === 'primary' ? { id: 'gallery-primary', primary: true, size, state } : { id: `gallery-${kind}`, override: { body: kind, face: kind, accessory: 0, palette: kind }, primary: false, size, state })
  }
  const base = { body: 0, face: 0, accessory: 0, palette: 0 }
  const idle = (override: typeof base, n: number, key: string): Cell => ({ id: `gallery-${key}-${n}`, override, primary: false, size: 36, state: 'idle' })
  for (let f = 0; f < 6; f++) cells.push(idle({ ...base, face: f }, f, 'face'))
  for (let a = 0; a < 9; a++) cells.push(idle({ ...base, accessory: a }, a, 'accessory'))
  for (let p = 0; p < 8; p++) cells.push(idle({ ...base, palette: p }, p, 'palette'))
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
  return `<!doctype html><html data-theme="${theme}" data-window-focused="true"><head><meta charset="utf-8"><style>${css}\n${page}</style></head><body>${cells.join('')}</body></html>`
}

type ArtCell = { body: number | 'sun'; palette: number | 'sun'; face: number; size: number }

export async function artGalleryHtml(theme: Theme): Promise<string> {
  renderer ??= load()
  const render = await renderer
  const css = await readFile(new URL('bot-avatar.css', CSS_DIR), 'utf8')
  const cell = ({ body, palette, face, size }: ArtCell) => {
    const props = body === 'sun'
      ? { id: 'art-sun', primary: true, size, state: 'idle', theme }
      : { id: `art-${body}-${palette}-${face}`, override: { body, face, accessory: 0, palette }, primary: false, size, state: 'idle', theme }
    return `<div class="art-cell" data-size="${size}" data-body="${body}" data-palette="${palette}">${render(props)}</div>`
  }
  const row = (cells: ArtCell[]) => `<div class="art-row">${cells.map(cell).join('')}</div>`
  const rows: string[] = []
  for (const size of SIZES) {
    const cells: ArtCell[] = [{ body: 'sun', palette: 'sun', face: 0, size }]
    for (const body of [0, 1, 2, 3, 4, 5]) for (const palette of [0, 3, 5]) cells.push({ body, palette, face: 0, size })
    rows.push(row(cells))
  }
  rows.push(row([0, 1, 2, 3, 4, 5, 6, 7].map(palette => ({ body: 0, palette, face: 0, size: 36 }))))
  rows.push(row([0, 1, 2, 3, 4, 5].map(face => ({ body: 0, palette: 0, face, size: 64 }))))
  const names = ['Orchestrator', 'Reliability', 'Test runner', 'Developer', 'Office', 'Designer']
  const strip = [0, 1, 2, 3, 4, 5].map((body, i) => `<div class="art-strip-row">${cell({ body, palette: [0, 1, 2, 3, 4, 5][i]!, face: i % 6, size: 36 })}<span>${names[i]}</span></div>`)
  const sidebar = `<div class="art-strip"><div class="art-strip-hero">${cell({ body: 'sun', palette: 'sun', face: 0, size: 64 })}<span>Primary</span></div>${strip.join('')}</div>`
  const color = theme === 'dark' ? '#e6e6e6' : '#1c1c1c'
  const page = `body { margin: 0; padding: 12px; background: ${await railBg(theme)}; color: ${color}; font: 14px -apple-system, sans-serif; display: flex; gap: 24px; align-items: flex-start; }
.art-rows { display: flex; flex-direction: column; gap: 12px; }
.art-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.art-cell { display: flex; align-items: center; justify-content: center; }
.art-strip { width: 240px; display: flex; flex-direction: column; gap: 14px; padding: 12px; box-sizing: border-box; }
.art-strip-hero { display: flex; flex-direction: column; align-items: center; gap: 6px; margin-bottom: 8px; }
.art-strip-row { display: flex; align-items: center; gap: 12px; }`
  return `<!doctype html><html data-theme="${theme}" data-window-focused="true"><head><meta charset="utf-8"><style>${css}\n${page}</style></head><body><div class="art-rows">${rows.join('')}</div>${sidebar}</body></html>`
}
