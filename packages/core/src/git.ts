import { simpleGit, type SimpleGit } from 'simple-git'
import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BinaryProvider } from './binary.js'
import { defaultBinaryProvider } from './binary.js'

export const localOnlyList = (workspace: string): string => join(workspace, '.engram', 'local-only')
export async function keepLocalOnly(workspace: string): Promise<void> {
  const want = (await readFile(localOnlyList(workspace), 'utf8').catch(() => '')).split('\n').filter(Boolean)
  if (!want.length) return
  if (!(await lstat(join(workspace, '.git')).catch(() => null))?.isDirectory()) throw new Error('local-only files cannot be kept out: this workspace has no .git folder of its own')
  const file = join(workspace, '.git', 'info', 'exclude')
  const held = await readFile(file, 'utf8').catch(() => '')
  const have = new Set(held.split('\n')), missing = want.filter(line => !have.has(line))
  if (!missing.length) return
  await mkdir(join(file, '..'), { recursive: true })
  await appendFile(file, `${held && !held.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`)
}

export function bundledGitExecPath(provider: BinaryProvider): string | null {
  const bundled = provider as { gitExecPath?(): string | null }
  return bundled.gitExecPath?.() ?? null
}

const UNFORWARDABLE_ENV = new Set([
  'EDITOR',
  'VISUAL',
  'PAGER',
  'PREFIX',
  'SSH_ASKPASS',
  'GIT_ASKPASS',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_PROXY_COMMAND',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_TEMPLATE_DIR',
])

export function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (UNFORWARDABLE_ENV.has(key.toUpperCase())) continue
    env[key] = value
  }
  env['GIT_TERMINAL_PROMPT'] = '0'
  return env
}

export function bundledGitEnv(execPath: string): Record<string, string> {
  const env = gitEnv()
  env['GIT_EXEC_PATH'] = execPath
  env['GIT_TEMPLATE_DIR'] = execPath.replace('libexec/git-core', 'share/templates')
  return env
}

export class GitLayer {
  private git: SimpleGit

  constructor(
    readonly workdir: string,
    provider: BinaryProvider = defaultBinaryProvider,
  ) {
    const execPath = bundledGitExecPath(provider)
    this.git = simpleGit({
      baseDir: workdir,
      binary: provider.git(),
      config: ['core.autocrlf=false'],
      timeout: { block: 30_000 },
      ...(execPath ? { unsafe: { allowUnsafeConfigPaths: true, allowUnsafeTemplateDir: true } } : {}),
    })
    this.git = this.git.env(execPath ? bundledGitEnv(execPath) : gitEnv())
  }

  async init(): Promise<void> {
    await this.git.init(['-b', 'main'])
    await this.git.addConfig('user.name', 'Engram')
    await this.git.addConfig('user.email', 'engram@local')
    await this.autoCommit('vault: initial commit')
  }

  async isRepo(): Promise<boolean> {
    return this.git.checkIsRepo()
  }

  async autoCommit(message: string): Promise<string | null> {
    await keepLocalOnly(this.workdir)
    await this.git.add('-A')
    const status = await this.git.status()
    if (status.staged.length === 0 && status.files.length === 0) return null
    const result = await this.git.commit(message)
    return result.commit || null
  }

  async revertCommit(hash: string): Promise<void> {
    await this.git.raw(['revert', '--no-edit', hash])
  }

  async revertLast(): Promise<void> {
    await this.revertCommit('HEAD')
  }

  async log(maxCount = 20): Promise<{ hash: string; message: string }[]> {
    const entries = await this.git.log({ maxCount })
    return entries.all.map((e) => ({ hash: e.hash, message: e.message }))
  }

  async raw(args: string[]): Promise<string> {
    return this.git.raw(args)
  }

  async untrack(relPath: string): Promise<boolean> {
    const tracked = await this.git.raw(['ls-files', '--', relPath])
    if (!tracked.trim()) return false
    await this.git.raw(['rm', '--cached', '--ignore-unmatch', '--', relPath])
    await this.autoCommit(`vault: retire ${relPath} from tracking (app-managed, not backed up)`)
    return true
  }
}
