import { createHash } from 'node:crypto'
import { mkdir, writeFile, access, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENTS_MD_SHIPPED, AGENTS_MD_V1 } from './agents-template.js'
import type { BinaryProvider } from './binary.js'
import { defaultBinaryProvider } from './binary.js'
import { GitLayer } from './git.js'

// Physical layout per and §10:
//   EngramRoot/
//     workspace/   ← the ONLY cwd ever handed to engines; git repo root
//       AGENTS.md  notes/  inbox/  sources/  _views/  .engram/(cache)
//     private/     ← engines never receive this path
export interface VaultPaths {
  root: string
  workspace: string
  notes: string
  inbox: string
  sources: string
  views: string
  cache: string
  privateDir: string
}

export function vaultPaths(root: string): VaultPaths {
  const workspace = join(root, 'workspace')
  return {
    root,
    workspace,
    notes: join(workspace, 'notes'),
    inbox: join(workspace, 'inbox'),
    sources: join(workspace, 'sources'),
    views: join(workspace, '_views'),
    cache: join(workspace, '.engram'),
    privateDir: join(root, 'private'),
  }
}

export interface InitVaultOptions {
  // Fixture vaults skip git so they can live inside another repo.
  git?: boolean
  provider?: BinaryProvider
}

export async function initVault(root: string, options: InitVaultOptions = {}): Promise<VaultPaths> {
  const paths = vaultPaths(root)
  const legacyCache = join(paths.workspace, '.strata')
  try {
    await access(legacyCache)
    await access(paths.cache).catch(async () => {
      await rename(legacyCache, paths.cache)
    })
  } catch {
    /* no legacy cache */
  }
  for (const dir of [paths.notes, paths.inbox, paths.sources, paths.views, paths.cache, paths.privateDir]) {
    await mkdir(dir, { recursive: true })
  }
  await syncAgentsMd(paths)
  await writeFile(join(paths.workspace, '.gitignore'), '_views/\n.engram/\nAGENTS.md\n', { flag: 'wx' }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err
    },
  )
  const gitignorePath = join(paths.workspace, '.gitignore')
  try {
    let ignore = await readFile(gitignorePath, 'utf8')
    let changed = false
    if (!ignore.includes('.engram/')) {
      ignore = ignore.replace(/\.strata\//g, '.engram/')
      changed = true
    }
    if (!/^AGENTS\.md$/m.test(ignore)) {
      ignore = `${ignore.replace(/\n?$/, '\n')}AGENTS.md\n`
      changed = true
    }
    if (changed) await writeFile(gitignorePath, ignore)
  } catch {
    /* just written above */
  }
  if (options.git !== false) {
    const git = new GitLayer(paths.workspace, options.provider ?? defaultBinaryProvider)
    if (!(await isVaultRepo(paths))) await git.init()
    // Existing vaults committed AGENTS.md before it was app-managed — retire it
    // from tracking (keeps the local file) so no backup ever carries it.
    await git.untrack('AGENTS.md').catch(() => undefined)
  }
  return paths
}

function agentsReceipt(paths: VaultPaths): string {
  return join(paths.cache, 'agents-written')
}

function hashOf(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
}

export async function syncAgentsMd(paths: VaultPaths): Promise<'created' | 'upgraded' | 'kept' | 'user-owned'> {
  const file = join(paths.workspace, 'AGENTS.md')
  const current = hashOf(AGENTS_MD_V1)
  let live: string
  try {
    live = await readFile(file, 'utf8')
  } catch {
    await writeFile(file, AGENTS_MD_V1)
    await writeFile(agentsReceipt(paths), current).catch(() => undefined)
    return 'created'
  }
  const hash = hashOf(live)
  if (hash === current) {
    await writeFile(agentsReceipt(paths), current).catch(() => undefined)
    return 'kept'
  }
  const receipt = await readFile(agentsReceipt(paths), 'utf8').catch(() => '')
  const ours = receipt.trim() === hash || (AGENTS_MD_SHIPPED as readonly string[]).includes(hash)
  if (!ours) return 'user-owned'
  await writeFile(file, AGENTS_MD_V1)
  await writeFile(agentsReceipt(paths), current).catch(() => undefined)
  return 'upgraded'
}

async function isVaultRepo(paths: VaultPaths): Promise<boolean> {
  try {
    await access(join(paths.workspace, '.git'))
    return true
  } catch {
    return false
  }
}
