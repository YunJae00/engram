// Entry for the bundled MCP server (esbuild → bundle/mcp/engram-mcp.cjs).
// Runs under the app's own executable with ELECTRON_RUN_AS_NODE=1, spawned by
// the MCP client (Claude Desktop / Claude Code) — never by the app itself.
import { startMcpServer } from '../../../packages/core/src/mcp.ts'

const arg = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

void startMcpServer(process.stdin, process.stdout, {
  vaultRoot: arg('--vault'),
  registryPath: arg('--registry'),
})
