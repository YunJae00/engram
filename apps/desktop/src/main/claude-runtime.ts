import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { x as extract } from 'tar'
import { renameWithRetry } from 'core'

export const CLAUDE_RUNTIME_VERSION = '0.3.272'
export const CLAUDE_INSTALL_HELP = 'https://code.claude.com/docs/en/setup'
const LIMIT = 300 * 1024 * 1024

function runtimeHome(): string { return join(app.getPath('userData'), 'runtimes', 'claude', CLAUDE_RUNTIME_VERSION) }
export function installedClaudeBinary(): string | null {
  const path = join(runtimeHome(), 'runtime', process.platform === 'win32' ? 'claude.exe' : 'claude')
  return existsSync(path) && existsSync(join(runtimeHome(), 'sdk', 'sdk.mjs')) ? path : null
}
export async function loadClaudeSdk(): Promise<unknown> {
  return import(/* @vite-ignore */ claudeSdkUrl())
}
export function claudeSdkUrl(): string {
  if (!installedClaudeBinary()) throw new Error('Install the Claude runtime in Settings → AI before connecting.')
  return pathToFileURL(join(runtimeHome(), 'sdk', 'sdk.mjs')).href
}

export function registryArchive(value: unknown): { url: string; integrity: string } {
  const dist = (value as { dist?: { tarball?: unknown; integrity?: unknown } })?.dist
  if (typeof dist?.tarball !== 'string' || typeof dist.integrity !== 'string') throw new Error('The registry returned incomplete package information.')
  const url = new URL(dist.tarball)
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dist.integrity)) throw new Error('The registry returned an untrusted package source.')
  return { url: url.href, integrity: dist.integrity }
}

export function safeRuntimeEntry(path: string, type: string): boolean {
  const parts = path.replaceAll('\\', '/').split('/')
  return parts[0] === 'package' && !parts.some(part => part === '..' || part.includes(':')) && (type === 'File' || type === 'Directory')
}

async function downloadPackage(name: string, destination: string, archive: string, signal: AbortSignal): Promise<void> {
  const metadata = await net.fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${CLAUDE_RUNTIME_VERSION}`, { signal, redirect: 'error' })
  if (!metadata.ok) throw new Error(`Could not find the official Claude package (${metadata.status}).`)
  const source = registryArchive(await metadata.json())
  const response = await net.fetch(source.url, { signal, redirect: 'error' })
  if (!response.ok || !response.body) throw new Error(`Claude download failed (${response.status}).`)
  const hash = createHash('sha512')
  const file = await open(archive, 'wx')
  const reader = response.body.getReader()
  let size = 0
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      signal.throwIfAborted()
      size += chunk.length
      if (size > LIMIT) throw new Error('The Claude package exceeds the download limit.')
      hash.update(chunk)
      await file.writeFile(chunk)
    }
  } finally { try { await reader.cancel() } finally { await file.close() } }
  if (`sha512-${hash.digest('base64')}` !== source.integrity) throw new Error('Claude package verification failed. Nothing was installed.')
  await mkdir(destination)
  let unpacked = 0
  let unsafe = false
  await extract({ file: archive, cwd: destination, strip: 1, strict: true, preservePaths: false, filter: (path, entry) => {
    unpacked += entry.size
    if (!('type' in entry) || !safeRuntimeEntry(path, entry.type) || unpacked > LIMIT * 3) unsafe = true
    return !unsafe
  } })
  if (unsafe) throw new Error('The Claude package contains an unsafe archive entry.')
  await rm(archive)
}

let installing: Promise<void> | null = null
export function installClaudeRuntime(): Promise<void> {
  if (installing) return installing
  installing = (async () => {
    if (installedClaudeBinary()) return
    if (!['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'].includes(`${process.platform}-${process.arch}`)) throw new Error('Claude installation is not supported on this platform.')
    const parent = join(app.getPath('userData'), 'runtimes', 'claude')
    await mkdir(parent, { recursive: true })
    const staging = await mkdtemp(join(parent, '.install-'))
    const signal = AbortSignal.timeout(5 * 60_000)
    try {
      await downloadPackage('@anthropic-ai/claude-agent-sdk', join(staging, 'sdk'), join(staging, 'sdk.tgz'), signal)
      await downloadPackage(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, join(staging, 'runtime'), join(staging, 'runtime.tgz'), signal)
      if (!existsSync(join(staging, 'sdk', 'sdk.mjs')) || !existsSync(join(staging, 'runtime', process.platform === 'win32' ? 'claude.exe' : 'claude'))) throw new Error('The downloaded runtime is incomplete.')
      await renameWithRetry(staging, runtimeHome())
    } finally { await rm(staging, { recursive: true, force: true }) }
  })().finally(() => { installing = null })
  return installing
}
