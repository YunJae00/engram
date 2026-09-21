import { parentPort, workerData } from 'node:worker_threads'
import { devLanguage } from './dev-language.js'

try { parentPort!.postMessage({ result: devLanguage(workerData.root, workerData.path, workerData.text, workerData.position, workerData.kind) }) }
catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : 'Language tools are unavailable.' }) }
