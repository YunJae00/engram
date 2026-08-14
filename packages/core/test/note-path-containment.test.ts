import { describe, expect, it } from 'vitest'
import { notePath } from '../src/notes.js'
import type { VaultPaths } from '../src/vault.js'

const paths = { notes: '/vault/workspace/notes' } as VaultPaths

describe('a note id cannot leave notes/', () => {
  it('accepts the ids the vault actually uses', () => {
    for (const id of ['n-mrx8osm9-l3o6zr', 'n-deploy-0001', 'n-a01', 'n-1']) {
      expect(notePath(paths, id)).toContain(id)
    }
  })

  for (const evil of [
    '../../../etc/passwd',
    '..\\..\\Windows\\System32\\drivers\\etc\\hosts',
    'n-x/../../escape',
    'sub/dir',
    'sub\\dir',
    '..',
    '',
  ]) {
    it(`refuses ${JSON.stringify(evil)}`, () => {
      expect(() => notePath(paths, evil)).toThrow(/unsafe note id/)
    })
  }

  // A NUL byte truncates the path in some syscalls — reject rather than trust
  // the platform to reject it for us.
  it('refuses an embedded NUL', () => {
    expect(() => notePath(paths, 'n-ok-0001\0.png')).toThrow(/unsafe note id/)
  })
})
