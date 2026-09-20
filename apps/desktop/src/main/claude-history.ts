import { Worker } from 'node:worker_threads'
import { claudeSdkUrl } from './claude-runtime.js'
import { accountEnvironment } from './account-profiles.js'

export function claudeHistory<T>(profile: string, method: 'list' | 'read', options: { dir?: string; limit: number }, id?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(accountEnvironment('claude', profile)).filter((row): row is [string, string] => row[1] !== undefined))
    const worker = new Worker(new URL('./claude-history-worker.js', import.meta.url), { env, workerData: { sdk: claudeSdkUrl(), method, options, id } })
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Session history did not respond in time.')) }, 30_000)
    worker.once('message', (message: { result: T; error?: string }) => { clearTimeout(timer); if (message.error) reject(new Error(message.error)); else resolve(message.result) })
    worker.once('error', error => { clearTimeout(timer); reject(error) })
    worker.once('exit', () => { clearTimeout(timer); reject(new Error('The history reader closed before returning a result.')) })
  })
}
