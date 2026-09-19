import { parentPort, workerData } from 'node:worker_threads'
import { BundledBinaryProvider, GitLayer, initVault, TeamSync, vaultPaths } from 'core'

const port = parentPort!
const { task, root, message, bin } = workerData
const provider = new BundledBinaryProvider(bin)
const paths = vaultPaths(root)
try {
  let result: unknown
  if (task === 'init') result = await initVault(root, { provider })
  else if (task === 'commit') result = await new GitLayer(paths.workspace, provider).autoCommit(message)
  else if (task === 'status') {
    const sync = new TeamSync(paths, provider)
    const status = await sync.status({ fetch: false })
    const remote = await sync.remoteUrl()
    result = { ...status, ...(remote ? { remote } : {}) }
  } else throw new Error('Unknown backup operation')
  port.postMessage({ result })
} catch (error) { port.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
finally { port.close() }
