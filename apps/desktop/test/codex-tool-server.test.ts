import { expect, it, vi } from 'vitest'
import { startToolServer } from '../src/main/codex-tool-server.js'

it('serves only the given tools over authenticated JSON-RPC and reports tool failures as tool errors', async () => {
  const server = await startToolServer([
    { name: 'note_read', description: 'Read a note', argsSchema: { properties: { id: { type: 'string' } }, required: ['id'] }, run: async args => `body of ${String(args['id'])}` },
    { name: 'fail', description: 'Always fails', argsSchema: {}, run: async () => { throw new Error('not allowed') } },
  ])
  const rpc = (body: unknown, auth = `Bearer ${server.token}`) => fetch(server.url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer nope')).status).toBe(401)
    expect((await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json()).result.protocolVersion).toBe('2025-03-26')
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
    expect(list.result.tools).toEqual([
      { name: 'note_read', description: 'Read a note', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } },
    ])
    expect((await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'note_read', arguments: { id: 'n1' } } })).json()).result).toEqual({ content: [{ type: 'text', text: 'body of n1' }] })
    expect((await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fail', arguments: {} } })).json()).result).toEqual({ content: [{ type: 'text', text: 'not allowed' }], isError: true })
    expect((await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'shell', arguments: {} } })).json()).result.isError).toBe(true)
    expect((await (await rpc({ jsonrpc: '2.0', id: 6, method: 'resources/list' })).json()).error.code).toBe(-32601)
  } finally { await server.close() }
})

it('rejects malformed and browser-origin requests without dispatching or crashing, then closes on cancellation', async () => {
  const abort = new AbortController(), run = vi.fn(async () => 'ok')
  const server = await startToolServer([{ name: 'write', description: 'fixture', argsSchema: {}, run }], abort.signal)
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write' } }
  const post = (body: unknown, extra = {}) => fetch(server.url, { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) })
  try {
    for (const body of [null, [null], [], 1, { ...request, params: null }, { ...request, id: {} }]) expect((await post(body)).status).toBe(400)
    expect((await post(request, { Origin: 'https://untrusted.example' })).status).toBe(403)
    expect(run).not.toHaveBeenCalled()
    expect((await post(request)).status).toBe(200)
    expect(run).toHaveBeenCalledTimes(1)
    abort.abort()
    await expect(post(request)).rejects.toThrow()
    expect(run).toHaveBeenCalledTimes(1)
  } finally { await server.close() }
})
