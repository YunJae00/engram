import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { NODE_BIN } from './launch-local.mjs'

export function parseCloudOutput(text) {
  const sessionId = text.match(/session_[A-Za-z0-9]+/)?.[0] ?? null
  const url = text.match(/https:\/\/claude\.ai\/code\/[\w\-/?=&.%]+/)?.[0] ?? null
  return { sessionId, url }
}

export async function launchCloud({ launchWorktree, prompt, logPath }) {
  // claude --cloud refuses a non-TTY stdout; script provides the pty.
  const child = spawn('script', ['-q', logPath, 'claude', '--cloud', prompt], {
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
