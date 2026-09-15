import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { connect, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { initVault, loadBots } from 'core'
import type { VaultContext } from '../src/main/vault.js'

const fake = vi.hoisted(() => ({ data: '', approve: vi.fn(), clearWork: vi.fn(), settings: { computerUse: false } }))
vi.mock('electron', () => ({ app: { getPath: () => fake.data }, dialog: { showMessageBox: fake.approve } }))
vi.mock('../src/main/agent-courier.js', () => ({ agentCourier: () => ({}) }))
vi.mock('../src/main/agent-browser.js', () => ({ resetLane: async () => {} }))
vi.mock('../src/main/office-agent.js', () => ({ officeAgentTools: () => [] }))
vi.mock('../src/main/application-work.js', () => ({ clearApplicationWork: fake.clearWork }))
vi.mock('../src/main/file-work.js', () => ({ cometFileTools: () => [] }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => fake.settings }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: () => {} }))
import { externalInfoPath, externalOwns, externalStatus, setExternalContext, setExternalEnabled } from '../src/main/external-connection.js'

const clients: Socket[] = []
afterEach(async () => { clients.forEach(socket => socket.destroy()); clients.length = 0; await setExternalEnabled(false) })

it('requires a reviewed goal and per-call consent, refuses duplicates, and aborts a pending approval on disconnect', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  fake.data = await mkdtemp(resolve('tmp/external-connection-'))
  const paths = await initVault(join(fake.data, 'vault'), { git: false })
  setExternalContext({ paths, store: { getAll: () => [] } } as unknown as VaultContext)
  await setExternalEnabled(true)
  const address = JSON.parse(await readFile(externalInfoPath(), 'utf8')) as { pipe: string; token: string }
  const unauthorized = connect(address.pipe); clients.push(unauthorized)
  await once(unauthorized, 'connect')
  expect(externalStatus().connected).toBe(0)
  const rejected = once(unauthorized, 'close')
  unauthorized.write(JSON.stringify({ token: 'invalid', id: 'bad', method: 'tools' }) + '\n')
  await rejected
  expect(fake.approve).not.toHaveBeenCalled()
  const socket = connect(address.pipe); clients.push(socket)
  const lines = createInterface({ input: socket })
  const pending = new Map<string, (value: { result?: { content: { text: string }[] }; error?: string }) => void>()
  lines.on('line', line => { const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id) })
  let serial = 0
  const request = (name: string, args: object, id = String(++serial)) => new Promise<{ result?: { content: { text: string }[] }; error?: string }>(resolve => {
    pending.set(id, resolve)
    socket.write(JSON.stringify({ token: address.token, id, method: 'call', params: { name, args } }) + '\n')
  })
  expect((await request('engram_capture', { text: 'must not write' })).error).toContain('engram_begin')
  fake.approve.mockResolvedValue({ response: 0 })
  expect((await request('engram_begin', { goal: 'Remember a test decision' })).error).toContain('declined')
  expect(await readdir(paths.inbox)).toHaveLength(0)
  fake.approve.mockResolvedValue({ response: 1 })
  expect((await request('engram_begin', { goal: 'Remember a test decision' })).error).toBeUndefined()
  expect(externalStatus().connected).toBe(1)
  const bot = (await loadBots(paths))[0]!
  expect(externalOwns(`bot-${bot.id}`)).toBe(true)
  expect((await request('engram_capture', { text: { nested: true } })).error).toContain('Invalid tool arguments')
  expect((await request('engram_capture', { text: 'Test decision' }, 'write-once')).error).toBeUndefined()
  expect((await request('engram_capture', { text: 'Duplicate' }, 'write-once')).error).toContain('Duplicate')
  expect((await readdir(paths.inbox)).filter(name => name.endsWith('-capture.md'))).toHaveLength(1)
  fake.approve.mockResolvedValue({ response: 0 })
  expect((await request('engram_capture', { text: 'Denied' })).error).toContain('declined')
  expect((await readdir(paths.inbox)).filter(name => name.endsWith('-capture.md'))).toHaveLength(1)
  let signal: AbortSignal | undefined
  fake.approve.mockImplementation((options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    signal = options.signal
    signal.addEventListener('abort', () => reject(new Error('Canceled')), { once: true })
  }))
  void request('engram_search', { query: 'test' })
  await vi.waitFor(() => expect(signal).toBeDefined())
  socket.destroy()
  await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  await vi.waitFor(() => expect(externalStatus().active).toBe(false))
  expect(externalOwns(`bot-${bot.id}`)).toBe(false)
  expect(fake.clearWork).toHaveBeenCalledWith(`bot-${bot.id}`)
  const audit = await readFile(join(fake.data, 'external', 'audit.jsonl'), 'utf8')
  expect(audit).toContain('engram_capture')
  expect(audit).not.toContain('Test decision')
  const switched = connect(address.pipe); clients.push(switched)
  await once(switched, 'connect')
  const closed = once(switched, 'close')
  const otherPaths = await initVault(join(fake.data, 'other-vault'), { git: false })
  setExternalContext({ paths: otherPaths, store: { getAll: () => [] } } as unknown as VaultContext)
  await closed
})

it('runs the shipped stdio entry through the authenticated app bridge without an AI account', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  fake.data = await mkdtemp(resolve('tmp/external-stdio-'))
  const paths = await initVault(join(fake.data, 'vault'), { git: false })
  fake.approve.mockReset().mockResolvedValue({ response: 1 })
  setExternalContext({ paths, store: { getAll: () => [] } } as unknown as VaultContext)
  await setExternalEnabled(true)
  const entry = join(fake.data, 'engram-mcp.cjs')
  await build({ entryPoints: [resolve('apps/desktop/scripts/mcp-entry.mjs')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: entry, logLevel: 'silent' })
  const child = spawn(process.execPath, [entry, '--bridge', externalInfoPath()], { windowsHide: true, stdio: 'pipe' })
  const responses = new Map<number, { result?: { content?: { text: string }[]; tools?: { name: string }[]; serverInfo?: { name: string } }; error?: unknown }>()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => { const value = JSON.parse(line); responses.set(value.id, value) })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  let id = 0
  const request = async (method: string, params: object) => {
    const at = ++id
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: at, method, params }) + '\n')
    await vi.waitFor(() => expect(responses.has(at), stderr).toBe(true), { timeout: 10000 })
    return responses.get(at)!
  }
  try {
    expect((await request('initialize', { protocolVersion: '2025-06-18' })).result?.serverInfo?.name).toBe('engram')
    const names = (await request('tools/list', {})).result?.tools?.map(tool => tool.name)
    expect(names).toContain('engram_begin')
    expect(names).toContain('open_page')
    expect((await request('tools/call', { name: 'engram_begin', arguments: { goal: 'Remember a fixture decision' } })).result?.content?.[0]?.text).toContain('approved')
    const captured = await request('tools/call', { name: 'engram_capture', arguments: { text: 'A fixture decision, not real user data.' } })
    expect(captured.error).toBeUndefined()
    expect((await readdir(paths.inbox)).filter(name => name.endsWith('-capture.md'))).toHaveLength(1)
    await request('tools/call', { name: 'engram_finish', arguments: { summary: 'The fixture decision was stored.' } })
    const bot = (await loadBots(paths))[0]!
    expect(externalOwns(`bot-${bot.id}`)).toBe(false)
    expect(fake.clearWork).toHaveBeenCalledWith(`bot-${bot.id}`)
    expect((await request('tools/call', { name: 'engram_begin', arguments: { goal: 'A second task in the same client' } })).result?.content?.[0]?.text).toContain('approved')
    expect(await loadBots(paths)).toHaveLength(2)
    const exited = once(child, 'exit')
    child.stdin.end()
    expect((await exited)[0]).toBe(0)
  } finally { child.kill(); lines.close() }
})
