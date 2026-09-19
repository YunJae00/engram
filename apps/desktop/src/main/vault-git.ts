import { app } from 'electron'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { VaultPaths, SyncStatus } from 'core'

interface Results { init: VaultPaths; commit: string | null; status: SyncStatus & { remote?: string } }
let queue: Promise<unknown> = Promise.resolve()

// Saving a note can start several git processes; none may block window input.
export function vaultGit<T extends keyof Results>(task: T, root: string, message?: string): Promise<Results[T]> {
  const pending = queue.then(() => new Promise<Results[T]>((resolve, reject) => {
    const bin = app.isPackaged ? join(process.resourcesPath, 'bin') : join(app.getAppPath(), 'bundle')
    const worker = new Worker(new URL('./vault-git-worker.js', import.meta.url), { workerData: { task, root, message, bin } })
    worker.once('message', reply => reply.error ? reject(new Error(reply.error)) : resolve(reply.result))
    worker.once('error', reject)
    worker.once('exit', () => reject(new Error('The backup worker closed before returning a result.')))
  }))
  queue = pending.catch(() => undefined)
  return pending
}
