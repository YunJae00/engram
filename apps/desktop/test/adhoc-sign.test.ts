import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: () => false, mkdtempSync: vi.fn(), rmSync: vi.fn() }))
import { execFileSync } from 'node:child_process'
import adhocSign, { signMacTarget } from '../scripts/adhoc-sign.mjs'

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it('signs the resource helper before the app and verifies both without a local identity', async () => {
  vi.stubEnv('ENGRAM_MAC_SIGN_IDENTITY', '')
  await adhocSign({ electronPlatformName: 'darwin', arch: 4, appOutDir: '/tmp/sign-test', packager: { appInfo: { productFilename: 'Engram' }, info: { projectDir: '/tmp/sign-test' } } })
  const calls = vi.mocked(execFileSync).mock.calls.map(([tool, args]) => [tool, args])
  const app = join('/tmp/sign-test', 'Engram.app')
  const helper = join(app, 'Contents', 'Resources', 'bin', 'desktop', 'EngramDesktop')
  expect(calls).toEqual([
    ['codesign', ['--force', '--sign', '-', '--identifier', 'dev.engram.desktop', helper]],
    ['codesign', ['--verify', '--strict', helper]],
    ['codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'dev.engram.app', app]],
    ['codesign', ['--verify', '--deep', '--strict', app]],
  ])
})

it('pins the certificate leaf in the designated requirement when an identity is supplied', () => {
  vi.stubEnv('ENGRAM_MAC_SIGN_IDENTITY', 'Engram Code Signing')
  vi.stubEnv('ENGRAM_MAC_SIGN_KEYCHAIN', '/tmp/signing.keychain-db')
  const requirement = 'identifier "dev.engram.desktop" and certificate leaf = H"d07aaaf365c495145f4e6cbac17d0fb72f140dc4"'
  vi.mocked(execFileSync).mockReturnValueOnce('').mockReturnValueOnce('').mockReturnValueOnce(`designated => ${requirement}`)
  signMacTarget('/tmp/helper', 'dev.engram.desktop')
  expect(execFileSync).toHaveBeenNthCalledWith(1, 'codesign', [
    '--force', '--sign', 'Engram Code Signing', '--keychain', '/tmp/signing.keychain-db',
    '--identifier', 'dev.engram.desktop', '--requirements', `=designated => ${requirement}`, '/tmp/helper',
  ], { stdio: 'inherit' })
})
