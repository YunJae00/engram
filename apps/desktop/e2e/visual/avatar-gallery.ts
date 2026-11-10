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
