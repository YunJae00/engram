import { exec } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, ipcMain } from 'electron'
import type { McpConnectResultDto, McpInfoDto } from '../shared/types.js'

const execAsync = promisify(exec)

// One-click MCP hookup: every Claude on this machine becomes a satellite of
// the vault. The server is the bundled engram-mcp script run through OUR OWN
// executable in Node mode (ELECTRON_RUN_AS_NODE) — no Node install needed on
// the user's machine, and the client spawns it on demand, so the app itself
// carries zero runtime cost and does not need to be running.

function serverScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'mcp', 'engram-mcp.cjs')
    : join(app.getAppPath(), 'bundle', 'mcp', 'engram-mcp.cjs')
}

// The registry (vaults.json) is passed instead of a vault path so a workspace
// switch in the app is picked up by satellites without reconfiguring.
function serverSpec(): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: [serverScriptPath(), '--registry', join(app.getPath('userData'), 'vaults.json')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

function desktopConfigPath(): string {
  if (process.platform === 'win32') return join(process.env['APPDATA'] ?? '', 'Claude', 'claude_desktop_config.json')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

async function connectClaudeDesktop(): Promise<McpConnectResultDto> {
  const configPath = desktopConfigPath()
  const dir = join(configPath, '..')
  try {
    await access(dir)
  } catch {
    return { ok: false, code: 'not-installed' }
  }
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    /* missing or unparseable — start fresh (a broken file is replaced) */
  }
  const servers = (config['mcpServers'] ?? {}) as Record<string, unknown>
  servers['engram'] = serverSpec()
  config['mcpServers'] = servers
  await mkdir(dir, { recursive: true })
  await writeFile(configPath, JSON.stringify(config, null, 2))
  return { ok: true }
}

// `claude mcp add` fails on a duplicate name — treat that as "reconnect":
// drop the stale entry (old paths from before a rename/move) and re-add.
async function connectClaudeCode(): Promise<McpConnectResultDto> {
  const spec = serverSpec()
  const addCmd = `claude mcp add engram --scope user -e ELECTRON_RUN_AS_NODE=1 -- "${spec.command}" "${spec.args[0]}" --registry "${spec.args[2]}"`
  const run = async (cmd: string) => execAsync(cmd, { windowsHide: true, timeout: 20_000 })
  try {
    await run(addCmd)
    return { ok: true }
  } catch (err) {
    const text = String((err as { stderr?: string; message?: string }).stderr ?? (err as Error).message ?? err)
    if (/already exists/i.test(text)) {
      try {
        await run('claude mcp remove engram -s user')
        await run(addCmd)
        return { ok: true }
      } catch (retryErr) {
        return { ok: false, code: 'failed', detail: String((retryErr as Error).message ?? retryErr).slice(0, 300) }
      }
    }
    if (/not recognized|not found|ENOENT/i.test(text)) return { ok: false, code: 'no-cli' }
    return { ok: false, code: 'failed', detail: text.slice(0, 300) }
  }
}

// The /engram slash command, shipped to ~/.claude/commands so every Claude
// Code user gets the shorthand without any setup. Kept in sync on boot.
const ENGRAM_COMMAND = `---
description: Put something into your Engram second brain, or pull something out — /engram <instruction or content>
---
The user's Engram second brain is connected via MCP tools: \`engram_capture\`, \`engram_search\`, \`engram_context\`, \`engram_brief\`, \`engram_alias\`.

Request: $ARGUMENTS

Decide the intent and act — do not ask which one they meant. Always answer in the language the user wrote in.

**Brief** — the request is about the brain itself rather than a topic (a briefing, "what happened today", status, a summary):
Call \`engram_brief\` and relay it conversationally (workspace, waiting captures, the librarian's briefing).

**Alias** — the request says two or more names mean the same thing ("X and Y are the same", "we call it Y for short"):
Call \`engram_alias\` with the equivalent names. Confirm in one short line. From then on search bridges those names automatically.

**Save (the default)** — the request asks to remember/store/file something, refers to earlier content ("this", "what we just decided"), or is itself raw content to keep:
1. Pull the relevant substance from the conversation above (decisions, facts, requests, outcomes — not chit-chat).
2. Write it as ONE self-contained note **in the language the user is writing in**: first line \`# title\`, then a body that still makes sense later without this conversation (what was decided or learned, why, key numbers, names and dates). Preserve emphasis the user voiced ("never", "must", "do not forget") and conditional reminders ("next time I do X, …") verbatim — the librarian turns those into salience and future-trigger metadata.
3. Call \`engram_capture\` with it. If there are clearly separate topics, capture each as its own note.
4. Confirm in one short line what was saved. The librarian files it later — never mention inbox mechanics.

**Find** — the request asks about past knowledge ("what was …", "look up", "search"):
1. Call \`engram_search\` with focused terms. When the first search misses, try the same idea in another language — vaults are often mixed, and the user's taught aliases are applied automatically.
2. If the user needs substance rather than titles, follow with \`engram_context\` and answer from it, citing note titles.

If the search truly finds nothing, say so plainly and suggest one alternative query — do not fabricate memories.
`

async function installSlashCommand(): Promise<void> {
  const target = join(homedir(), '.claude', 'commands', 'engram.md')
  const current = await readFile(target, 'utf8').catch(() => null)
  if (current === ENGRAM_COMMAND) return
  await mkdir(join(homedir(), '.claude', 'commands'), { recursive: true })
  await writeFile(target, ENGRAM_COMMAND)
}

export async function autoConnectMcp(notify: (targets: string[]) => void): Promise<void> {
  if (!app.isPackaged) return
  const updated: string[] = []
  // Claude Desktop: merge only when the entry is missing or stale.
  try {
    const configPath = desktopConfigPath()
    await access(join(configPath, '..')) // Claude Desktop installed?
    let config: Record<string, unknown> = {}
    try {
      config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    } catch {
      /* missing/unreadable — start fresh */
    }
    const servers = (config['mcpServers'] ?? {}) as Record<string, unknown>
    const desired = serverSpec()
    if (JSON.stringify(servers['engram']) !== JSON.stringify(desired)) {
      servers['engram'] = desired
      config['mcpServers'] = servers
      await writeFile(configPath, JSON.stringify(config, null, 2))
      updated.push('Claude Desktop')
    }
  } catch {
    /* not installed — nothing to connect */
  }
  // Claude Code: re-register when missing or pointing at old paths.
  try {
    const spec = serverSpec()
    const current = await execAsync('claude mcp get engram', { windowsHide: true, timeout: 15_000 })
      .then((r) => r.stdout)
      .catch((err) => String((err as { stdout?: string }).stdout ?? ''))
    if (!(current.includes(spec.command) && current.includes(spec.args[0]!))) {
      const result = await connectClaudeCode()
      if (result.ok) updated.push('Claude Code')
    }
  } catch {
    /* no claude CLI — nothing to connect */
  }
  // Ship/refresh the /engram shorthand for Claude Code (silent; harmless if
  // Claude Code is absent — the file just waits for it).
  await installSlashCommand().catch(() => {})
  if (updated.length > 0) notify(updated)
}

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:info', async (): Promise<McpInfoDto> => {
    const spec = serverSpec()
    let scriptExists = true
    try {
      await access(serverScriptPath())
    } catch {
      scriptExists = false
    }
    return {
      configJson: JSON.stringify({ mcpServers: { engram: spec } }, null, 2),
      desktopConfigPath: desktopConfigPath(),
      scriptExists,
    }
  })
  ipcMain.handle('mcp:connectDesktop', () => connectClaudeDesktop())
  ipcMain.handle('mcp:connectCode', () => connectClaudeCode())
}
