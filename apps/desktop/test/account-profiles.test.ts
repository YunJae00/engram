import { mkdtemp, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
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

it('leaves the system config directories unset unless the user environment defines them', async () => {
  const original = { ...process.env }
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/accounts-unset-'))
  try {
    delete process.env['CLAUDE_CONFIG_DIR']
    delete process.env['CODEX_HOME']
    await initializeAccountProfiles(root)
    expect('CLAUDE_CONFIG_DIR' in accountEnvironment('claude', 'system')).toBe(false)
    expect('CODEX_HOME' in accountEnvironment('codex', 'system')).toBe(false)
    expect('CLAUDE_CONFIG_DIR' in process.env).toBe(false)
    expect('CODEX_HOME' in process.env).toBe(false)
    const id = (await addAccountProfile('claude', 'Work')).profiles[0]!.id
    expect(accountEnvironment('claude', id)['CLAUDE_CONFIG_DIR']).toBe(join(root, 'account-profiles', id))
    await selectAccountProfile('claude', id)
    expect(process.env['CLAUDE_CONFIG_DIR']).toBe(join(root, 'account-profiles', id))
    await selectAccountProfile('claude', 'system')
    expect('CLAUDE_CONFIG_DIR' in process.env).toBe(false)
    await initializeAccountProfiles(root)
    expect('CLAUDE_CONFIG_DIR' in process.env).toBe(false)
    expect('CODEX_HOME' in process.env).toBe(false)
    expect('CLAUDE_CONFIG_DIR' in accountEnvironment('claude', 'system')).toBe(false)
  } finally { process.env = original }
})

it('keeps a defined but empty system config directory resolved to the default path', async () => {
  const original = { ...process.env }
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/accounts-empty-'))
  try {
    process.env['CLAUDE_CONFIG_DIR'] = ''
    process.env['CODEX_HOME'] = ''
    await initializeAccountProfiles(root)
    expect(accountEnvironment('claude', 'system')['CLAUDE_CONFIG_DIR']).toBe(join(homedir(), '.claude'))
    expect(accountEnvironment('codex', 'system')['CODEX_HOME']).toBe(join(homedir(), '.codex'))
  } finally { process.env = original }
})

it('leaves CODEX_HOME unset after switching from an added codex profile back to system and restarting', async () => {
  const original = { ...process.env }
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/accounts-codex-unset-'))
  try {
    delete process.env['CLAUDE_CONFIG_DIR']
    delete process.env['CODEX_HOME']
    await initializeAccountProfiles(root)
    const id = (await addAccountProfile('codex', 'Work')).profiles[0]!.id
    await selectAccountProfile('codex', id)
    expect(process.env['CODEX_HOME']).toBe(join(root, 'account-profiles', id))
    await selectAccountProfile('codex', 'system')
    expect('CODEX_HOME' in process.env).toBe(false)
    await initializeAccountProfiles(root)
    expect('CODEX_HOME' in process.env).toBe(false)
    expect('CLAUDE_CONFIG_DIR' in process.env).toBe(false)
    expect('CODEX_HOME' in accountEnvironment('codex', 'system')).toBe(false)
    expect('CLAUDE_CONFIG_DIR' in accountEnvironment('claude', 'system')).toBe(false)
    expect(accountEnvironment('codex', id)['CODEX_HOME']).toBe(join(root, 'account-profiles', id))
  } finally { process.env = original }
})
