import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../../scripts/verify-cli-args.mjs'

describe('verify-cli args', () => {
  it('defaults the root to the script repo', () => {
    expect(parseArgs(['boot', '--build'], '/repo', '/cwd')).toEqual({ name: 'boot', root: '/repo', build: true, list: false })
  })

  it('resolves --root against cwd and never takes its value as the scenario', () => {
    expect(parseArgs(['--root', 'tmp/orch/next', 'boot'], '/repo', '/repo')).toMatchObject({ name: 'boot', root: resolve('/repo', 'tmp/orch/next') })
    expect(parseArgs(['boot', '--root', '/abs/next'], '/repo', '/cwd')).toMatchObject({ name: 'boot', root: '/abs/next' })
    expect(parseArgs(['--list', '--root', 'x'], '/repo', '/c')).toMatchObject({ list: true, name: '', root: resolve('/c', 'x') })
  })

  it('rejects --root without a directory', () => {
    expect(() => parseArgs(['boot', '--root'], '/repo', '/cwd')).toThrow(/needs a directory/)
    expect(() => parseArgs(['boot', '--root', '--build'], '/repo', '/cwd')).toThrow(/needs a directory/)
  })
})
