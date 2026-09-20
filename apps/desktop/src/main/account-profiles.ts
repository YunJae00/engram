import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { renameWithRetry } from 'core'
import type { AccountProfiles, AccountProvider } from '../shared/account-profiles.js'

let root = '', state: AccountProfiles = { profiles: [], selected: { claude: 'system', codex: 'system' } }
let systemPaths: Record<AccountProvider, string>
let saving: Promise<unknown> = Promise.resolve()
const providerKey = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' } as const

export async function initializeAccountProfiles(userData: string): Promise<void> {
  root = join(userData, 'account-profiles')
  state = { profiles: [], selected: { claude: 'system', codex: 'system' } }
  systemPaths = { claude: process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), codex: process.env['CODEX_HOME'] || join(homedir(), '.codex') }
  try {
    const saved = JSON.parse(await readFile(join(root, 'profiles.json'), 'utf8'))
    if (!Array.isArray(saved.profiles) || !saved.selected || !saved.systemPaths) throw new Error('Invalid account profile settings.')
    if (saved.profiles.some((row: { id: string; provider: string; name: string }) => !/^[a-f0-9-]{36}$/.test(row.id) || !['claude', 'codex'].includes(row.provider) || typeof row.name !== 'string')) throw new Error('Invalid account profile.')
    state = { profiles: saved.profiles, selected: saved.selected }
    systemPaths = saved.systemPaths
    for (const provider of ['claude', 'codex'] as const) {
      if (typeof systemPaths[provider] !== 'string' || !isAbsolute(systemPaths[provider])) throw new Error('Invalid system profile.')
      process.env[providerKey[provider]] = profilePath(provider, state.selected[provider])
      if (state.selected[provider] !== 'system') {
        const inherited = provider === 'claude' ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] : ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_SQLITE_HOME']
        for (const key of inherited) delete process.env[key]
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
export function accountProfiles(): AccountProfiles { return structuredClone(state) }
export function activeAccountProfile(provider: AccountProvider): string { return state.selected[provider] }
function profilePath(provider: AccountProvider, id: string): string {
  if (id === 'system') return systemPaths[provider]
  if (!state.profiles.some(profile => profile.id === id && profile.provider === provider)) throw new Error('Unknown account profile.')
  return join(root, id)
}
async function save(next: AccountProfiles): Promise<void> {
  const pending = join(root, `${randomUUID()}.tmp`)
  await mkdir(root, { recursive: true })
  await writeFile(pending, JSON.stringify({ ...next, systemPaths }), { mode: 0o600 })
  await renameWithRetry(pending, join(root, 'profiles.json'))
  state = next
}
export function addAccountProfile(provider: AccountProvider, name: string): Promise<AccountProfiles> {
  const work = async () => {
    if (!['claude', 'codex'].includes(provider) || typeof name !== 'string' || !name.trim() || name.length > 60) throw new Error('Enter an account label of up to 60 characters.')
    if (state.profiles.length >= 20) throw new Error('Up to 20 account profiles are supported.')
    const profile = { id: randomUUID(), provider, name: name.trim() }
    await mkdir(join(root, profile.id), { recursive: true })
    await save({ ...state, profiles: [...state.profiles, profile] })
    return accountProfiles()
  }
  const result = saving.then(work); saving = result.catch(() => undefined); return result
}
export async function selectAccountProfile(provider: AccountProvider, id: string): Promise<void> {
  await saving
  if (!['claude', 'codex'].includes(provider)) throw new Error('Unknown provider.')
  profilePath(provider, id)
  await save({ ...state, selected: { ...state.selected, [provider]: id } })
}
