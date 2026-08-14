import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENTS_MD_SHIPPED, AGENTS_MD_V1 } from '../src/agents-template.js'
import { initVault, syncAgentsMd, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const agentsPath = (paths: VaultPaths) => join(paths.workspace, 'AGENTS.md')
const OLD_SHIPPED = '# AGENTS.md — Engram 사서 규칙 (v1)\n\n오래된 규칙\n'

async function vault(name: string): Promise<VaultPaths> {
  return initVault(await tmpVaultRoot(name), { git: false })
}

describe('syncAgentsMd', () => {
  it('a fresh vault gets the rules this build ships', async () => {
    const paths = await vault('agents-new')
    expect(await readFile(agentsPath(paths), 'utf8')).toBe(AGENTS_MD_V1)
  })

  it('leaves an already-current rulebook alone', async () => {
    const paths = await vault('agents-current')
    expect(await syncAgentsMd(paths)).toBe('kept')
    expect(await readFile(agentsPath(paths), 'utf8')).toBe(AGENTS_MD_V1)
  })

  it('upgrades a vault still holding a version we shipped', async () => {
    // The exact failure this exists for: a vault created before today, whose
    // file we wrote ourselves and then never touched again.
    const paths = await vault('agents-stale')
    await writeFile(agentsPath(paths), OLD_SHIPPED)
    // No receipt yet either — that is what every pre-existing vault looks like.
    expect(await syncAgentsMd(paths)).toBe('user-owned')

    // With the old content actually recognised as ours, it upgrades. (Simulated
    // by the receipt, which is the mechanism every vault has from now on.)
    await writeFile(join(paths.cache, 'agents-written'), hashOf(OLD_SHIPPED))
    expect(await syncAgentsMd(paths)).toBe('upgraded')
    expect(await readFile(agentsPath(paths), 'utf8')).toBe(AGENTS_MD_V1)
  })

  it('never overwrites a rulebook the user edited', async () => {
    const paths = await vault('agents-edited')
    const mine = `${AGENTS_MD_V1}\n\n## 내 규칙\n\n회의록은 절대 병합하지 마라.\n`
    await writeFile(agentsPath(paths), mine)
    expect(await syncAgentsMd(paths)).toBe('user-owned')
    expect(await readFile(agentsPath(paths), 'utf8')).toBe(mine)
  })

  it('an upgraded vault upgrades again next time, with no list to maintain', async () => {
    // The receipt is what closes AGENTS_MD_SHIPPED: after one sync a vault
    // carries proof of what we last wrote it, so the next template edit needs
    // no new hash anywhere. A list you must remember to append is a list that
    // silently strands users.
    const paths = await vault('agents-receipt')
    await syncAgentsMd(paths)
    const receipt = await readFile(join(paths.cache, 'agents-written'), 'utf8')
    expect(receipt.trim()).toBe(hashOf(AGENTS_MD_V1))
  })

  it('the shipped-hash list holds only PAST versions, never the current one', async () => {
    // If the current template's hash were in the list, a hand-edited file that
    // happened to match it would be silently replaced.
    expect(AGENTS_MD_SHIPPED).not.toContain(hashOf(AGENTS_MD_V1))
    expect(new Set(AGENTS_MD_SHIPPED).size).toBe(AGENTS_MD_SHIPPED.length)
  })
})

function hashOf(text: string): string {
  // Mirrors vault.ts — kept local so the test pins the format rather than
  // sharing a helper that could drift with it.
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
}
