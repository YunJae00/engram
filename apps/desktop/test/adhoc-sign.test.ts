import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: () => false, mkdtempSync: vi.fn(), rmSync: vi.fn() }))
import { execFileSync } from 'node:child_process'
import adhocSign from '../scripts/adhoc-sign.mjs'

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
