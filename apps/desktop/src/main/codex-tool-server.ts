import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ToolSessionCall } from 'core'

// The comet's tools, served to the ChatGPT runtime as a Model Context Protocol
// server for one turn: loopback only, a fresh bearer token per turn, JSON-RPC
// over plain HTTP responses. The runtime's own tools stay off, so every action
// goes through these tools and their approvals.

export interface ToolServer { url: string; token: string; close(): Promise<void> }

const MAX_BODY = 4 * 1024 * 1024
type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

async function answer(tools: ToolSessionCall[], request: RpcRequest): Promise<unknown> {
  const params = request.params ?? {}
  switch (request.method) {
    case 'initialize':
      return { protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'engram', version: '1' } }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: { type: 'object', ...tool.argsSchema } })) }
    case 'tools/call': {
      const tool = tools.find(one => one.name === params['name'])
      if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${String(params['name'])}` }], isError: true }
      const args = params['arguments']
      try {
        if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) throw new Error('Tool arguments must be an object.')
        const result = await tool.run(args as Record<string, unknown> | undefined ?? {})
        if (typeof result === 'string') return { content: [{ type: 'text', text: result }] }
        return { content: [{ type: 'text', text: result.text }, ...(result.image ? [{ type: 'image', data: result.image.data, mimeType: result.image.mimeType }] : [])] }
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${String(request.method)}`), { code: -32601 })
  }
}

export async function startToolServer(tools: ToolSessionCall[], signal?: AbortSignal): Promise<ToolServer> {
  signal?.throwIfAborted()
  const token = randomBytes(32).toString('base64url'), expected = Buffer.from(`Bearer ${token}`)
  let closed = false
  const server = createServer((req, res) => {
    req.on('error', () => res.destroy())
    if (closed || signal?.aborted) { res.writeHead(503).end(); return }
    const auth = Buffer.from(String(req.headers.authorization ?? ''))
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(401).end(); return }
    const address = server.address()
    if (!address || typeof address === 'string' || req.headers.host !== `127.0.0.1:${address.port}` || req.headers.origin) { res.writeHead(403).end(); return }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return }
    if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(405).end(); return }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY) req.destroy(); else chunks.push(chunk) })
    req.on('end', () => void (async () => {
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.writeHead(400).end(); return }
      const requests = Array.isArray(body) ? body : [body]
      if (!requests.length || requests.some(request => !request || typeof request !== 'object' || Array.isArray(request)
        || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
        || (request.id !== undefined && request.id !== null && typeof request.id !== 'string' && typeof request.id !== 'number')
        || (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params))))) { res.writeHead(400).end(); return }
      const replies = (await Promise.all(requests.map(async request => {
        if (request.id === undefined) return null
        try {
          if (closed) throw new Error('The tool session has ended.')
          signal?.throwIfAborted()
          return { jsonrpc: '2.0', id: request.id, result: await answer(tools, request) }
        }
        catch (error) { return { jsonrpc: '2.0', id: request.id, error: { code: (error as { code?: number }).code ?? -32603, message: error instanceof Error ? error.message : String(error) } } }
      }))).filter(Boolean)
      if (!replies.length) { res.writeHead(202).end(); return }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Array.isArray(body) ? replies : replies[0]))
    })().catch(() => { res.destroy() }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The tool server did not start.')
  const onAbort = (): void => { closed = true; server.closeAllConnections(); server.close() }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    close: () => new Promise(resolve => { closed = true; signal?.removeEventListener('abort', onAbort); server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
