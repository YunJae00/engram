import { mkdtemp, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'
import { initializeAccountProfiles, accountProfiles, addAccountProfile, selectAccountProfile } from '../src/main/account-profiles.js'

it('keeps profile storage separate and restores the original system directory', async () => {
  const original = { ...process.env }
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/accounts-'))
  try {
    process.env['CLAUDE_CONFIG_DIR'] = join(root, 'system-claude')
    process.env['CODEX_HOME'] = join(root, 'system-codex')
    await initializeAccountProfiles(root)
    await expect(addAccountProfile('codex', '')).rejects.toThrow('label')
    const profiles = await addAccountProfile('codex', 'Work'), id = profiles.profiles[0]!.id
    await expect(selectAccountProfile('claude', id)).rejects.toThrow('Unknown')
    await selectAccountProfile('codex', id)
    expect(process.env['CODEX_HOME']).toBe(join(root, 'system-codex'))
    await initializeAccountProfiles(root)
    expect(process.env['CODEX_HOME']).toBe(join(root, 'account-profiles', id))
    expect(process.env['CLAUDE_CONFIG_DIR']).toBe(join(root, 'system-claude'))
    expect(accountProfiles().selected.codex).toBe(id)
    await selectAccountProfile('codex', 'system')
    await initializeAccountProfiles(root)
    expect(process.env['CODEX_HOME']).toBe(join(root, 'system-codex'))
  } finally { process.env = original }
})
