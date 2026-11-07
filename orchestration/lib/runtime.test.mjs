import { describe, expect, it } from 'vitest'
import { codexSandbox } from './runtime.mjs'

describe('codexSandbox', () => {
  it('gives the desktop verifier full access so Electron can start', () => {
    for (const platform of ['darwin', 'win32', 'linux']) expect(codexSandbox('verify', 'desktop', platform)).toBe('danger-full-access')
  })
  it('keeps the other verifier kinds in workspace-write on macOS and Windows', () => {
    for (const platform of ['darwin', 'win32'])
      for (const kind of ['tests', 'spec', 'break', undefined]) expect(codexSandbox('verify', kind, platform)).toBe('workspace-write')
  })
  it('gives every verifier kind full access on a Linux host', () => {
    for (const kind of ['tests', 'spec', 'break', 'desktop']) expect(codexSandbox('verify', kind, 'linux')).toBe('danger-full-access')
  })
  it('keeps implement and design sandboxes unchanged', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(codexSandbox('implement', undefined, platform)).toBe('danger-full-access')
      expect(codexSandbox('design', undefined, platform)).toBe('workspace-write')
    }
  })
})
