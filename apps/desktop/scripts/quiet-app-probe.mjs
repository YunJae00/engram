import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export function nativeProbe() {
  const binary = fileURLToPath(new URL(`../native-bin/desktop/EngramDesktop${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
  const child = spawn(binary, ['--owner-pid', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map()
  let serial = 0
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let packet
    try { packet = JSON.parse(line) } catch { return }
    if (packet.type === 'ready') readyResolve()
    if (packet.type === 'fatal') readyReject(new Error(packet.error))
    const waiting = pending.get(packet.id)
    if (waiting) { pending.delete(packet.id); clearTimeout(waiting.timer); if (packet.error) waiting.reject(new Error(packet.error)); else waiting.resolve(packet.result) }
  })
  child.on('error', readyReject)
  child.on('exit', () => {
    readyReject(new Error('Native helper exited'))
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Native helper exited')) }
    pending.clear()
  })
  return {
    ready,
    request(method, args = {}) {
      return new Promise((resolve, reject) => {
        const id = ++serial
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native request timed out')) }, 30_000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ id, method, ...args, expiresAt: Date.now() + 25_000 }) + '\n')
      })
    },
    close() { child.stdin.end(); child.kill() },
  }
}

export const appPatterns = [
  ['Claude', /claude/i], ['ChatGPT', /chatgpt/i], ['Teams', /microsoft teams|msteams|^teams$/i],
  ['Outlook', /outlook/i], [process.platform === 'win32' ? 'Notepad' : 'TextEdit', process.platform === 'win32' ? /notepad/i : /textedit/i],
]
export const appMatches = (item, pattern) => (item.aliases?.length ? [item.name, ...item.aliases] : [item.name, item.title]).some(name => pattern.test(name ?? ''))
