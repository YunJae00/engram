import { spawn } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

// The shell's default Node can be older than package.json engines, so prefer the newest nvm install.
function nodeBin() {
  const versions = join(process.env.NVM_DIR ?? join(homedir(), '.nvm'), 'versions', 'node')
  try {
    const newest = readdirSync(versions).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
    if (newest) return join(versions, newest, 'bin')
  } catch {
    return dirname(process.execPath)
  }
  return dirname(process.execPath)
}

export const NODE_BIN = nodeBin()

function detached(cmd, args, { cwd, stdoutPath, stderrPath }) {
  const out = openSync(stdoutPath, 'a')
  const err = stderrPath === stdoutPath ? out : openSync(stderrPath, 'a')
  try {
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      stdio: ['ignore', out, err],
      env: { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH ?? ''}` },
    })
    child.unref()
    return { pid: child.pid }
  } finally {
    closeSync(out)
    if (err !== out) closeSync(err)
  }
}

export function launchClaude({ cwd, prompt, logPath, outPath, schemaPath, addDirs = [] }) {
  const args = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'json']
  if (addDirs.length) args.push('--add-dir', ...addDirs)
  if (schemaPath) args.push('--json-schema', JSON.stringify(JSON.parse(readFileSync(schemaPath, 'utf8'))))
  return detached('claude', args, { cwd, stdoutPath: outPath, stderrPath: logPath })
}

export function launchCodex({ codexBin, cwd, prompt, logPath, outPath, sandbox, schemaPath, addDirs = [] }) {
  // A login shell sources nvm and puts the default Node (v22) ahead of NODE_BIN.
  const args = ['exec', '-C', cwd, '-s', sandbox, '-c', 'allow_login_shell=false', '--skip-git-repo-check', '--ephemeral']
  for (const dir of addDirs) args.push('--add-dir', dir)
  if (schemaPath) args.push('--output-schema', schemaPath)
  args.push('-o', outPath, '--json', prompt)
  return detached(codexBin, args, { cwd, stdoutPath: logPath, stderrPath: logPath })
}

const CLAUDE_USAGE_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']

export function parseClaudeTokens(text) {
  try {
    const usage = JSON.parse(text).usage
    if (!usage) return null
    const total = CLAUDE_USAGE_KEYS.reduce((sum, key) => sum + (usage[key] ?? 0), 0)
    return Number.isInteger(total) ? total : null
  } catch {
    return null
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

export function parseCodexTokens(text) {
  let found = null
  for (const line of text.split('\n')) {
    const event = line.includes('"turn.completed"') ? parseLine(line) : null
    if (event?.type === 'turn.completed' && event.usage) found = (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0)
  }
  return found
}

export async function readTokens(kind, outPath) {
  const text = await readFile(outPath, 'utf8').catch(() => '')
  return kind === 'claude' ? parseClaudeTokens(text) : parseCodexTokens(text)
}
