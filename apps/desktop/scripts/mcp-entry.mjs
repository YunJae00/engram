// Entry for the bundled MCP server (esbuild → bundle/mcp/engram-mcp.cjs).
// Runs under the app's own executable with ELECTRON_RUN_AS_NODE=1, spawned by
// the MCP client (Claude Desktop / Claude Code) — never by the app itself.
import { startMcpServer } from '../../../packages/core/src/mcp.ts'
import { bridgeOptions } from './mcp-bridge.mjs'

const arg = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const bridge = arg('--bridge') ? await bridgeOptions(arg('--bridge')) : undefined
  try {
    await startMcpServer(process.stdin, process.stdout, bridge ?? { vaultRoot: arg('--vault'), registryPath: arg('--registry') })
  } finally { bridge?.close() }
}
void main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
