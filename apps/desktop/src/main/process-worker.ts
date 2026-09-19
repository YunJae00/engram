import { spawn } from 'node:child_process'
import { parentPort, workerData } from 'node:worker_threads'

const port = parentPort!
const child = spawn(workerData.command, workerData.args, {
  cwd: workerData.cwd, env: workerData.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
})
port.on('message', message => {
  if (message.type === 'kill') child.kill(message.signal)
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
child.on('exit', (code, signal) => port.postMessage({ type: 'exit', code, signal }))
child.on('close', (code, signal) => {
  port.postMessage({ type: 'close', code, signal })
  port.close()
})
process.on('exit', () => { if (child.exitCode === null && child.signalCode === null) child.kill() })
