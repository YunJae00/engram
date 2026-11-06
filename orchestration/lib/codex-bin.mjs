import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'

// Same triples as apps/desktop/src/main/engine-cloud.ts. The binary name differs on Windows.
const CODEX_TRIPLE = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
}

const listOrEmpty = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function codexCandidates(root, { platform, arch, override, listDir = listOrEmpty } = {}) {
  const paths = []
  const push = (path) => {
    if (path && !paths.includes(path)) paths.push(path)
  }
  if (override) push(isAbsolute(override) ? override : join(root, override))
  const key = `${platform}-${arch}`
  const triple = CODEX_TRIPLE[key]
  if (!triple) return paths
  const bin = join('vendor', triple, 'bin', platform === 'win32' ? 'codex.exe' : 'codex')
  const pkg = join('@openai', `codex-${key}`)
  for (const base of [join(root, 'apps/desktop/node_modules'), join(root, 'node_modules')]) {
    push(join(base, pkg, bin))
    push(join(base, '@openai/codex', '..', `codex-${key}`, bin))
  }
  for (const store of [join(root, 'node_modules/.pnpm'), join(root, 'apps/desktop/node_modules/.pnpm')]) {
    for (const name of listDir(store)) {
      if (!name.startsWith(`@openai+codex-${key}@`)) continue
      push(join(store, name, 'node_modules', pkg, bin))
    }
  }
  return paths
}

export function resolveCodexBin(root, { platform = process.platform, arch = process.arch, override, exists = existsSync, listDir } = {}) {
  const candidates = codexCandidates(root, { platform, arch, override, listDir })
  const found = candidates.find((path) => exists(path))
  if (found) return found
  const listed = candidates.map((path) => `- ${path}`).join('\n')
  throw new Error(`codex binary not found for ${platform}-${arch}. Tried:\n${listed || '- (no path for this platform)'}\nSet roles.codexBin to a binary that exists on this machine, or install @openai/codex-${platform}-${arch}.`)
}
