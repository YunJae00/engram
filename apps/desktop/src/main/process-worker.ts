import { spawn } from 'node:child_process'
import { parentPort, workerData } from 'node:worker_threads'

const port = parentPort!
const child = spawn(workerData.command, workerData.args, {
  cwd: workerData.cwd, env: workerData.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
})
let stopping = false
function stop(signal: NodeJS.Signals = 'SIGTERM'): void {
  if (stopping || child.exitCode !== null || child.signalCode !== null) return
  stopping = true
  if (workerData.killTree && process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    const fallback = setTimeout(() => child.kill(signal), 15_000)
    killer.on('error', () => { clearTimeout(fallback); child.kill(signal) })
    killer.on('exit', code => { clearTimeout(fallback); if (code !== 0) child.kill(signal) })
  } else child.kill(signal)
}
port.on('message', message => {
  if (message.type === 'kill') stop(message.signal)
  else if (message.type === 'destroy') child[message.stream as 'stdin' | 'stdout' | 'stderr'].destroy()
  else if (message.type === 'resume') child[message.stream as 'stdout' | 'stderr'].resume()
  else if (message.type === 'write') child.stdin.write(message.data, error => port.postMessage({ type: 'written', error: error?.message }))
  else if (message.type === 'end') child.stdin.end()
})
child.on('spawn', () => port.postMessage({ type: 'spawn', pid: child.pid }))
child.on('error', (error: NodeJS.ErrnoException) => port.postMessage({ type: 'error', error: error.message, code: error.code, syscall: error.syscall }))
child.stdin.on('error', error => port.postMessage({ type: 'inputError', error: error.message }))
for (const stream of ['stdout', 'stderr'] as const) {
  child[stream].on('data', data => {
    child[stream].pause()
    port.postMessage({ type: 'data', stream, data })
  })
  child[stream].on('end', () => port.postMessage({ type: 'end', stream }))
}
child.on('exit', (code, signal) => {
  port.postMessage({ type: 'exit', code, signal })
  if (stopping && workerData.killTree) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy() }
})
child.on('close', (code, signal) => {
  port.postMessage({ type: 'close', code, signal })
  port.close()
})
process.on('exit', () => { if (child.exitCode === null && child.signalCode === null) child.kill() })
