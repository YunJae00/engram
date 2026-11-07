import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { NODE_BIN } from './launch-local.mjs'

export function parseCloudOutput(text) {
  const sessionId = text.match(/session_[A-Za-z0-9]+/)?.[0] ?? null
  const url = text.match(/https:\/\/claude\.ai\/code\/[\w\-/?=&.%]+/)?.[0] ?? null
  return { sessionId, url }
}

/** Args after `script`: `claude [--model <id>] --cloud <prompt>`. */
export function cloudClaudeArgs(prompt, { model } = {}) {
  const args = ['claude']
  if (model) args.push('--model', model)
  args.push('--cloud', prompt)
  return args
}

// util-linux `script` runs one shell command via `-c`. Quote so the prompt is not expanded.
function shellJoin(args) {
  return args.map((arg) => `'${String(arg).replaceAll("'", `'\\''`)}'`).join(' ')
}

/**
 * `script` argv that runs `command` under a pty and writes the typescript to `logPath`.
 * macOS/BSD takes the command as trailing argv. util-linux rejects that ("unexpected number
 * of arguments") and wants `-c <command> <file>`; `-e` returns the command's exit code.
 */
export function scriptArgs(logPath, command, { platform = process.platform } = {}) {
  if (platform === 'linux') return ['-q', '-e', '-c', shellJoin(command), logPath]
  return ['-q', logPath, ...command]
}

export async function launchCloud({ launchWorktree, prompt, logPath, model }) {
  // claude --cloud refuses a non-TTY stdout; script provides the pty.
  const child = spawn('script', scriptArgs(logPath, cloudClaudeArgs(prompt, { model })), {
    cwd: launchWorktree,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH ?? ''}` },
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  const log = await readFile(logPath, 'utf8').catch(() => '')
  const { sessionId, url } = parseCloudOutput(`${out}\n${log}`)
  if (!sessionId) throw new Error(`claude --cloud gave no session id (exit ${code}):\n${out}\n${log}`)
  return { sessionId, url }
}
