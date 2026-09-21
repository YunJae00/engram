import { Worker } from 'node:worker_threads'
import { devReadFile } from './dev-files.js'
import type { DevLanguageResult } from '../shared/developers.js'

const active = new Set<string>()
export async function queryDevLanguage(root: string, path: string, text: string, position: number, kind: 'check' | 'complete' | 'definition'): Promise<DevLanguageResult> {
  if (typeof text !== 'string' || text.length > 500_000 || !Number.isInteger(position) || position < 0 || position > text.length || !['check', 'complete', 'definition'].includes(kind)) throw new Error('Invalid language request.')
  await devReadFile(root, path)
  if (active.has(root) || active.size >= 4) throw new Error('Language tools are busy. Try again shortly.')
  active.add(root)
  let worker: Worker | undefined
  try {
    worker = new Worker(new URL('./dev-language-worker.js', import.meta.url), { workerData: { root, path, text, position, kind }, resourceLimits: { maxOldGenerationSizeMb: 256 } })
    return await new Promise<DevLanguageResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Language analysis timed out. Narrow the project or use its build command.')), 20_000)
      worker!.once('message', message => { clearTimeout(timer); if (message.error) reject(new Error(message.error)); else resolve(message.result) })
      worker!.once('error', error => { clearTimeout(timer); reject(error) })
      worker!.once('exit', () => { clearTimeout(timer); reject(new Error('Language analysis stopped before completing.')) })
    })
  } finally { await worker?.terminate(); active.delete(root) }
}
