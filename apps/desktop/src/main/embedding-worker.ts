import { parentPort, workerData } from 'node:worker_threads'
import { env, pipeline } from '@huggingface/transformers'

const port = parentPort!
const { root, model } = workerData as { root: string; model: string }
env.localModelPath = root
env.allowLocalModels = true
env.allowRemoteModels = false
env.useFSCache = false

type Extractor = (texts: string[], options: { pooling: 'cls'; normalize: true }) => Promise<{ dims: number[]; data: Float32Array }>
let extractor: Extractor | null = null
let busy = false
port.on('message', async (request: { id: number; texts?: string[] }) => {
  if (busy) { port.postMessage({ id: request.id, error: 'Embedding worker is busy' }); return }
  busy = true
  try {
    if (!extractor) {
      extractor = await pipeline('feature-extraction', model, {
        dtype: 'q8', local_files_only: true,
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      }) as unknown as Extractor
    }
    if (!request.texts) { port.postMessage({ id: request.id }); return }
    const result = await extractor(request.texts, { pooling: 'cls', normalize: true })
    const data = Float32Array.from(result.data)
    port.postMessage({ id: request.id, data, dim: result.dims.at(-1) }, [data.buffer])
  } catch (error) {
    port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  } finally { busy = false }
})
