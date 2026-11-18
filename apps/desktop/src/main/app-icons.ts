import { readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { app, nativeImage, nativeTheme, type NativeImage } from 'electron'

const file = (): string => join(app.getPath('userData'), 'app-paths.json')
let paths: Promise<Record<string, string>> | null = null
let saving: Promise<void> = Promise.resolve()
const icons = new Map<string, Promise<string | undefined>>()

function known(): Promise<Record<string, string>> {
  paths ??= readFile(file(), 'utf8').then(raw => {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}
  }).catch(() => ({}))
  return paths
}

export const appPaths = (): Promise<Readonly<Record<string, string>>> => known()

export async function rememberAppPath(name: string, path: string): Promise<void> {
  const held = await known()
  const key = name.toLowerCase()
  if (!key || !path || held[key] === path) return
  held[key] = path
  icons.delete(`${key}:true`)
  icons.delete(`${key}:false`)
  saving = saving.then(() => writeFile(file(), JSON.stringify(held)), () => writeFile(file(), JSON.stringify(held)))
  await saving
}

async function packageLogo(program: string, dark: boolean): Promise<NativeImage | undefined> {
  const root = /^(.*?[\\/]WindowsApps[\\/][^\\/]+)[\\/]/i.exec(program)?.[1]
  if (!root) return undefined
  const logo = /Square44x44Logo="([^"]+)"/.exec(await readFile(join(root, 'AppxManifest.xml'), 'utf8').catch(() => ''))?.[1]
  if (!logo) return undefined
  const named = join(root, logo)
  const base = named.slice(0, -extname(named).length)
  for (const candidate of [`${base}.targetsize-32_altform-${dark ? '' : 'light'}unplated.png`, `${base}.targetsize-32.png`, `${base}.scale-200.png`, named]) {
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) return image
  }
  return undefined
}

export function appIcon(key: string): Promise<string | undefined> {
  const dark = nativeTheme.shouldUseDarkColors
  let icon = icons.get(`${key}:${dark}`)
  if (!icon) {
    icon = known().then(async held => {
      const path = held[key]
      if (!path) return undefined
      const image = await packageLogo(path, dark) ?? await app.getFileIcon(path, { size: 'normal' })
      return image.isEmpty() ? undefined : image.toDataURL()
    }).catch(() => undefined)
    icons.set(`${key}:${dark}`, icon)
  }
  return icon
}
