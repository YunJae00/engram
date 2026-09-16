import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { c as archive } from 'tar'
import { tmpVaultRoot } from '../../../packages/core/test/helpers.js'
import { installedClaudeBinary, installClaudeRuntime, registryArchive, safeRuntimeEntry } from '../src/main/claude-runtime.js'

const state = vi.hoisted(() => ({ root: '', fetch: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => state.root }, net: { fetch: (...args: unknown[]) => state.fetch(...args) } }))
beforeEach(async () => { state.root = await tmpVaultRoot('runtime-install'); state.fetch.mockReset() })

describe('separately installed Claude runtime', () => {
  it('rejects untrusted sources and archive traversal, links and devices', () => {
    expect(() => registryArchive({ dist: { tarball: 'https://other.example/runtime.tgz', integrity: 'sha512-YQ==' } })).toThrow()
    expect(() => registryArchive({ dist: { tarball: 'https://registry.npmjs.org/runtime.tgz', integrity: 'sha1-YQ==' } })).toThrow()
    for (const path of ['../escape', '/package/file', 'package/../escape', 'package/C:/escape']) expect(safeRuntimeEntry(path, 'File')).toBe(false)
    for (const type of ['SymbolicLink', 'Link', 'CharacterDevice']) expect(safeRuntimeEntry('package/file', type)).toBe(false)
    expect(safeRuntimeEntry('package/sdk.mjs', 'File')).toBe(true)
  })
  it('installs verified packages once, shares concurrent requests, and does not execute scripts', async () => {
    const source = join(state.root, 'source')
    await mkdir(join(source, 'package'), { recursive: true })
    await writeFile(join(source, 'package', 'sdk.mjs'), 'export const query = () => {}')
    await writeFile(join(source, 'package', process.platform === 'win32' ? 'claude.exe' : 'claude'), 'fixture, never executed')
    const path = join(state.root, 'package.tgz')
    await archive({ gzip: true, file: path, cwd: source }, ['package'])
    const data = await readFile(path)
    const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`
    state.fetch.mockImplementation(async (url: string) => url.endsWith('.tgz') ? new Response(data) : Response.json({ dist: { tarball: 'https://registry.npmjs.org/fixture.tgz', integrity } }))
    expect(installedClaudeBinary()).toBeNull()
    await Promise.all([installClaudeRuntime(), installClaudeRuntime()])
    expect(installedClaudeBinary()).toContain('runtimes')
    expect(state.fetch).toHaveBeenCalledTimes(4)
    await installClaudeRuntime()
    expect(state.fetch).toHaveBeenCalledTimes(4)
  })
  it('leaves no installed runtime after an integrity failure and allows retry', async () => {
    state.fetch.mockImplementation(async (url: string) => url.endsWith('.tgz') ? new Response('corrupt') : Response.json({ dist: { tarball: 'https://registry.npmjs.org/fixture.tgz', integrity: 'sha512-YQ==' } }))
    await expect(installClaudeRuntime()).rejects.toThrow('verification failed')
    expect(installedClaudeBinary()).toBeNull()
    await expect(installClaudeRuntime()).rejects.toThrow('verification failed')
  })
})
