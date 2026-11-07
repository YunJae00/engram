import { describe, expect, it } from 'vitest'
import { codexSandbox } from './runtime.mjs'

describe('codexSandbox', () => {
  it('gives the desktop verifier full access so Electron can start', () => {
    expect(codexSandbox('verify', 'desktop')).toBe('danger-full-access')
  })
  it('keeps the other verifier kinds in workspace-write', () => {
    for (const kind of ['tests', 'spec', 'break', undefined]) expect(codexSandbox('verify', kind)).toBe('workspace-write')
  })
  it('keeps implement and design sandboxes unchanged', () => {
    expect(codexSandbox('implement')).toBe('danger-full-access')
    expect(codexSandbox('design')).toBe('workspace-write')
  })
})
