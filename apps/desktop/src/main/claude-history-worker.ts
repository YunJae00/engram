import { parentPort, workerData } from 'node:worker_threads'
const port = parentPort!
try {
  const sdk = await import(/* @vite-ignore */ workerData.sdk)
  const result = workerData.method === 'list'
    ? await sdk.listSessions(workerData.options)
    : await sdk.getSessionMessages(workerData.id, workerData.options)
  port.postMessage({ result })
} catch (error) { port.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
finally { port.close() }
