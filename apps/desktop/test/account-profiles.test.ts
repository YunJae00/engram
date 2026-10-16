import { mkdtemp, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ connected: false, broken: false }))
vi.mock('../src/main/brain-connections.js', () => ({ connectionEnvironment: (provider: string, profile: string) => {
  if (!fake.connected || provider !== 'codex' || profile !== 'system') return {}
  if (fake.broken) throw new Error('Saved key unavailable')
  return { ENGRAM_CODEX_KEY: 'synthetic-company-key' }
} }))
import { initializeAccountProfiles, accountProfiles, accountEnvironment, addAccountProfile, selectAccountProfile } from '../src/main/account-profiles.js'

it('keeps profile storage separate and restores the original system directory', async () => {
  const original = { ...process.env }
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/accounts-'))
  try {
    process.env['CLAUDE_CONFIG_DIR'] = join(root, 'system-claude')
    process.env['CODEX_HOME'] = join(root, 'system-codex')
    process.env['OPENAI_API_KEY'] = 'test-system-key'
    await initializeAccountProfiles(root)
    const running = accountEnvironment('codex')
    await expect(addAccountProfile('codex', '')).rejects.toThrow('label')
    const profiles = await addAccountProfile('codex', 'Work'), id = profiles.profiles[0]!.id
    await expect(selectAccountProfile('claude', id)).rejects.toThrow('Unknown')
    await selectAccountProfile('codex', id)
    expect(process.env['CODEX_HOME']).toBe(join(root, 'account-profiles', id))
    expect(accountEnvironment('codex', id)['OPENAI_API_KEY']).toBeUndefined()
    expect(running['CODEX_HOME']).toBe(join(root, 'system-codex'))
    expect(running['OPENAI_API_KEY']).toBe('test-system-key')
    await initializeAccountProfiles(root)
    expect(process.env['CODEX_HOME']).toBe(join(root, 'account-profiles', id))
    expect(process.env['CLAUDE_CONFIG_DIR']).toBe(join(root, 'system-claude'))
    expect(accountProfiles().selected.codex).toBe(id)
    await selectAccountProfile('codex', 'system')
    expect(process.env['OPENAI_API_KEY']).toBe('test-system-key')
    await initializeAccountProfiles(root)
    expect(process.env['CODEX_HOME']).toBe(join(root, 'system-codex'))
  } finally { process.env = original }
})

it('injects a key only into the account that owns it, not another runtime or the app environment', async () => {
  const original = { ...process.env }
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/account-key-'))
  try {
    process.env['ENGRAM_CODEX_KEY'] = 'synthetic-inherited-key'
    await initializeAccountProfiles(root)
    fake.connected = true
    const other = (await addAccountProfile('codex', 'Other')).profiles[0]!.id
    expect(accountEnvironment('codex', 'system')['ENGRAM_CODEX_KEY']).toBe('synthetic-company-key')
    expect(accountEnvironment('codex', other)['ENGRAM_CODEX_KEY']).toBeUndefined()
    await selectAccountProfile('codex', other)
    expect(process.env['ENGRAM_CODEX_KEY']).toBeUndefined()
    expect(accountEnvironment('codex', 'system')['ENGRAM_CODEX_KEY']).toBe('synthetic-company-key')
    fake.broken = true
    await expect(selectAccountProfile('codex', 'system')).resolves.toBeUndefined()
    expect(accountProfiles().selected.codex).toBe('system')
    expect(() => accountEnvironment('codex', 'system')).toThrow(/key unavailable/)
    await expect(selectAccountProfile('codex', other)).resolves.toBeUndefined()
    expect(accountProfiles().selected.codex).toBe(other)
  } finally { fake.connected = false; fake.broken = false; process.env = original }
})
