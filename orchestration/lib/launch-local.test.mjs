import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NODE_BIN, withNodeOnPath } from './launch-local.mjs'

describe('withNodeOnPath', () => {
  it('prefixes Node with the platform delimiter and keeps a Windows Path key', () => {
    const input = { Path: 'C:\\Windows', OTHER: '1' }
    const env = withNodeOnPath(input)
    expect(env.Path).toBe(`${NODE_BIN}${delimiter}C:\\Windows`)
    expect(env.PATH).toBeUndefined()
    expect(env.OTHER).toBe('1')
    expect(input.Path).toBe('C:\\Windows')
  })

  it('sets PATH when the environment has none', () => {
    expect(withNodeOnPath({}).PATH).toBe(NODE_BIN)
  })
})
