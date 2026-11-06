import { describe, it, expect } from 'vitest'
import { overlaps, runnable } from './overlap.mjs'

const roles = { hardWhen: { sharedFiles: ['apps/desktop/src/main/ipc.ts'] } }
const item = (id, state, allowedFiles) => ({ id, state, allowedFiles })

describe('overlaps', () => {
  it('treats identical literal paths as overlapping', () => {
    expect(overlaps(['a/b.ts'], ['a/b.ts'])).toBe(true)
    expect(overlaps(['a/b.ts'], ['a/b.tsx'])).toBe(false)
  })

  it('matches a literal path under a glob prefix', () => {
    expect(overlaps(['packages/core/src/x.ts'], ['packages/**'])).toBe(true)
    expect(overlaps(['scripts/x.mjs'], ['packages/**'])).toBe(false)
  })

  it('compares glob prefixes in both directions', () => {
    expect(overlaps(['packages/core/**'], ['packages/**'])).toBe(true)
    expect(overlaps(['packages/**'], ['packages/core/**'])).toBe(true)
    expect(overlaps(['packages/core/**'], ['packages/mcp/**'])).toBe(false)
  })
})

describe('runnable', () => {
  it('blocks a briefed item that overlaps an in-flight item', () => {
    const items = [
      item('a', 'implementing', ['packages/core/**']),
      item('b', 'briefed', ['packages/core/src/x.ts']),
      item('c', 'briefed', ['scripts/y.mjs']),
    ]
    expect(runnable(items, roles)).toEqual(['c'])
  })

  it('ignores items that are not in flight', () => {
    const items = [item('a', 'verified', ['packages/**']), item('b', 'briefed', ['packages/x.ts'])]
    expect(runnable(items, roles)).toEqual(['b'])
  })

  it('does not start two overlapping briefed items in the same tick', () => {
    const items = [item('a', 'briefed', ['packages/**']), item('b', 'briefed', ['packages/x.ts'])]
    expect(runnable(items, roles)).toEqual(['a'])
  })

  it('holds the shared-file lock while another in-flight item uses the shared file', () => {
    const items = [
      item('a', 'verifying', ['apps/desktop/src/main/**']),
      item('b', 'briefed', ['apps/desktop/src/main/ipc.ts']),
    ]
    expect(runnable(items, roles)).toEqual([])
    items[0].state = 'merged'
    expect(runnable(items, roles)).toEqual(['b'])
  })
})
