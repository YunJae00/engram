import { access, copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, ipcMain } from 'electron'
import { claudeBinary, codexBinary, runText } from './engine-cloud.js'
import { externalInfoPath, externalStatus, setExternalEnabled, stopExternalCalls } from './external-connection.js'
import type { McpClientDto, McpConnectResultDto, McpInfoDto } from '../shared/types.js'

function serverScriptPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bin', 'mcp', 'engram-mcp.cjs') : join(app.getAppPath(), 'bundle', 'mcp', 'engram-mcp.cjs')
}
function serverSpec() {
  return { command: process.execPath, args: [serverScriptPath(), '--bridge', externalInfoPath()], env: { ELECTRON_RUN_AS_NODE: '1' } }
}
function desktopConfigPath(): string {
  if (process.platform === 'win32') return join(process.env['APPDATA'] ?? '', 'Claude', 'claude_desktop_config.json')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const owned = (value: unknown) => (JSON.stringify(value) ?? '').includes('engram-mcp.cjs')
const currentSpec = (text: string) => [serverSpec().command, ...serverSpec().args, 'ELECTRON_RUN_AS_NODE'].every(arg => text.includes(arg) || text.includes(JSON.stringify(arg).slice(1, -1)))

async function clientState(id: McpClientDto['id']): Promise<McpClientDto> {
  try {
    let text: string
    if (id === 'desktop') {
      const config: unknown = JSON.parse(await readFile(desktopConfigPath(), 'utf8'))
      if (!record(config) || config.mcpServers !== undefined && !record(config.mcpServers)) throw new Error('Invalid config')
      text = JSON.stringify(record(config.mcpServers) ? config.mcpServers.engram ?? {} : {})
    } else {
      const binary = id === 'claude' ? claudeBinary() : codexBinary()
      if (!binary) return { id, state: 'unavailable' }
      const result = await runText(binary, ['mcp', 'get', 'engram', ...(id === 'codex' ? ['--json'] : [])], 10000)
      if (result.code !== 0) return { id, state: /not found|no .*server|does not exist|not exist/i.test(result.out) ? 'not-configured' : 'error' }
      text = result.out
    }
    return { id, state: currentSpec(text) ? 'configured' : 'not-configured' }
  } catch (error) { return { id, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-configured' : 'error' } }
}

async function connectDesktop(): Promise<McpConnectResultDto> {
  const target = desktopConfigPath()
  try { await access(dirname(target)) } catch { return { ok: false, code: 'not-installed' } }
  let config: Record<string, unknown> = {}
  let existing = false
  try {
    const parsed: unknown = JSON.parse(await readFile(target, 'utf8'))
    if (!record(parsed) || parsed.mcpServers !== undefined && !record(parsed.mcpServers)) throw new Error('Invalid client config. Fix it before connecting; it has not been changed.')
    config = parsed; existing = true
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  if (servers.engram && !owned(servers.engram)) throw new Error('Another server uses the name engram. Rename it in the client before connecting.')
  const pending = `${target}.${randomUUID()}.tmp`
  try {
    if (existing) await copyFile(target, `${target}.${Date.now()}.bak`)
    await writeFile(pending, JSON.stringify({ ...config, mcpServers: { ...servers, engram: serverSpec() } }, null, 2), { mode: 0o600 })
    await rename(pending, target)
  } finally { await rm(pending, { force: true }) }
  return { ok: true }
}

async function connectCli(client: 'claude' | 'codex'): Promise<McpConnectResultDto> {
  const binary = client === 'claude' ? claudeBinary() : codexBinary()
  if (!binary) return { ok: false, code: 'no-cli' }
  const spec = serverSpec()
  const current = await runText(binary, ['mcp', 'get', 'engram', ...(client === 'codex' ? ['--json'] : [])], 15000)
  let restore: { file: string; before: string; removed: string } | undefined
  if (current.code === 0) {
    if (!owned(current.out)) throw new Error('Another server uses the name engram. Its configuration was not changed.')
    if (currentSpec(current.out)) return { ok: true }
    const file = client === 'codex' ? join(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'config.toml') : join(homedir(), '.claude.json')
    const before = await readFile(file, 'utf8')
    if (client === 'claude') {
      const config: unknown = JSON.parse(before)
      if (process.env['CLAUDE_CONFIG_DIR'] || !record(config) || !record(config.mcpServers) || !owned(config.mcpServers.engram)) throw new Error('The existing connection uses a different configuration scope. Remove it in the client, then reconnect.')
    }
    await copyFile(file, `${file}.${randomUUID()}.bak`)
    if (client === 'claude') {
      const removed = await runText(binary, ['mcp', 'remove', 'engram', '-s', 'user'], 15000)
      if (removed.code !== 0) throw new Error('Could not update the previous connection. Its configuration backup was kept.')
      restore = { file, before, removed: await readFile(file, 'utf8') }
    }
  }
  const args = client === 'claude'
    ? ['mcp', 'add', 'engram', '--scope', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', spec.command, ...spec.args]
    : ['mcp', 'add', 'engram', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', spec.command, ...spec.args]
  const added = await runText(binary, args, 20000)
  if (added.code !== 0 && restore && await readFile(restore.file, 'utf8') === restore.removed) {
    const pending = `${restore.file}.${randomUUID()}.tmp`
    try { await writeFile(pending, restore.before, { mode: 0o600 }); await rename(pending, restore.file) }
    finally { await rm(pending, { force: true }) }
  }
  return added.code === 0 ? { ok: true } : { ok: false, code: 'failed', detail: added.out.slice(-300) }
}

async function connect(client: 'desktop' | 'claude' | 'codex'): Promise<McpConnectResultDto> {
  try {
    await access(serverScriptPath())
    if (!externalStatus().enabled) throw new Error('Enable external connections first.')
    return client === 'desktop' ? await connectDesktop() : await connectCli(client)
  } catch (error) { return { ok: false, code: 'failed', detail: String((error as Error).message ?? error).slice(0, 300) } }
}

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:clients', () => Promise.all((['claude', 'codex', 'desktop'] as const).map(clientState)))
  ipcMain.handle('mcp:info', async (): Promise<McpInfoDto> => ({
    configJson: JSON.stringify({ mcpServers: { engram: serverSpec() } }, null, 2),
    desktopConfigPath: desktopConfigPath(), scriptExists: await access(serverScriptPath()).then(() => true, () => false),
  }))
  ipcMain.handle('mcp:connectDesktop', () => connect('desktop'))
  ipcMain.handle('mcp:connectCode', () => connect('claude'))
  ipcMain.handle('mcp:connectCodex', () => connect('codex'))
  ipcMain.handle('mcp:status', () => externalStatus())
  ipcMain.handle('mcp:enable', (_event, value: unknown) => { if (typeof value !== 'boolean') throw new Error('Invalid connection setting'); return setExternalEnabled(value) })
  ipcMain.handle('mcp:stop', () => stopExternalCalls())
  app.once('before-quit', () => { void setExternalEnabled(false) })
}
