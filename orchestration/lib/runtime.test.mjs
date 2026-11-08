import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { codexSandbox, launchAgent } from './runtime.mjs'

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

describe('local agent slots', () => {
  it('launches uncounted judges without a free local slot and never takes one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-slot-'))
    try {
      const sem = { free: () => 0, acquire: vi.fn() }
      const ctx = { root: dir, logs: join(dir, 'logs'), roles: { codexBin: process.execPath }, sem }
      const opts = { agent: 'codex-local', label: 'x-1-spec', cwd: dir, prompt: '-e 0', role: 'verify', kind: 'spec', minutes: 1 }
      expect(await launchAgent(ctx, opts)).toBeNull()
      const job = await launchAgent(ctx, { ...opts, counted: false })
      expect(job.pid).toBeGreaterThan(0)
      expect(sem.acquire).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
