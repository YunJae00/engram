import { parentPort, workerData } from 'node:worker_threads'
const port = parentPort!
try {
  const sdk = await import(/* @vite-ignore */ workerData.sdk)
  const { tail, ...options } = workerData.options as { tail?: number }
  const result = workerData.method === 'list'
    ? await sdk.listSessions(options)
    : tail ? (await sdk.getSessionMessages(workerData.id, options) as unknown[]).slice(-tail) : await sdk.getSessionMessages(workerData.id, options)
  port.postMessage({ result })
} catch (error) { port.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
finally { port.close() }
