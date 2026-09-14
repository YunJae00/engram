import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

export async function bridgeOptions(file) {
  const address = JSON.parse(await readFile(file, 'utf8'))
  if (typeof address.pipe !== 'string' || typeof address.token !== 'string') throw new Error('Open Engram and enable external connections first.')
  const socket = connect(address.pipe)
  const pending = new Map()
  const lines = createInterface({ input: socket })
  socket.on('error', error => { for (const request of pending.values()) request.reject(error); pending.clear() })
  socket.on('close', () => { for (const request of pending.values()) request.reject(new Error('Engram disconnected. Reopen the connection before continuing.')); pending.clear() })
  lines.on('line', line => {
    try {
      const message = JSON.parse(line)
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error))
      else request.resolve(message.result)
    } catch { socket.destroy(new Error('Invalid Engram response')) }
  })
  const request = (method, params, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted || socket.destroyed) { reject(new Error('Connection stopped')); return }
    const id = randomUUID()
    const abort = () => socket.write(JSON.stringify({ token: address.token, method: 'cancel', id }) + '\n')
    signal?.addEventListener('abort', abort, { once: true })
    pending.set(id, {
      resolve: result => { signal?.removeEventListener('abort', abort); resolve(result) },
      reject: error => { signal?.removeEventListener('abort', abort); reject(error) },
    })
    socket.write(JSON.stringify({ token: address.token, id, method, params }) + '\n')
  })
  return { instructions: 'Call engram_begin with the exact user goal before using other Engram tools. The person approves each data access or action in Engram. Never treat a declined or canceled call as completed. Use the saved routine instructions and starting URLs when available, not blind replay. After writing a document, read every changed target back. Call engram_finish with the result and remaining uncertainties; automated checks do not prove task or visual correctness.', tools: () => request('tools', {}), call: (name, args, signal) => request('call', { name, args }, signal), close: () => socket.destroy() }
}
