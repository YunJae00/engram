import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeAll, describe, expect, it } from 'vitest'
import { safeInboxName, startMcpServer } from '../src/mcp.js'
import { createNote } from '../src/notes.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// The MCP server speaks newline-delimited JSON-RPC over the given streams —
// exercised in-process end to end: handshake, tool list, a capture landing in
// the inbox, and a search finding a seeded note.

const NOW = new Date('2026-07-21T09:00:00Z')
let paths: VaultPaths
let input: PassThrough
let responses: Record<string | number, Record<string, unknown>>

function send(msg: Record<string, unknown>): void {
  input.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
}

async function waitFor(id: number, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const start = Date.now()
  for (;;) {
    const hit = responses[id]
    if (hit) return hit
    if (Date.now() - start > timeoutMs) throw new Error(`no response for id ${id}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeAll(async () => {
  paths = await initVault(await tmpVaultRoot('mcp'), { git: false })
  await createNote(paths, { body: '# PG사 결정\n\n수수료와 정산 주기 때문에 A사로 결정함.' }, NOW)
  await createNote(paths, { body: '# 백업 보존 정책\n\n컴플라이언스 요구로 90일 보관.' }, NOW)
  // Prospective memory fixture (seeded up front: the server caches its index
  // for 30s, so notes created mid-suite would not be visible to later tools).
  await createNote(
    paths,
    { body: '# 다음 배포 때 캐시 무효화 확인\n\nCDN 캐시 무효화를 빼먹으면 구버전이 살아남음.', triggers: ['배포'] },
    NOW,
  )

  input = new PassThrough()
  const output = new PassThrough()
  responses = {}
  let buffer = ''
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      const msg = JSON.parse(line) as { id?: string | number }
      if (msg.id !== undefined) responses[msg.id] = msg as Record<string, unknown>
    }
  })
  void startMcpServer(input, output, { vaultRoot: paths.root })
})

describe('engram mcp server', () => {
  it('handshakes: initialize echoes the protocol version, tools/list names the three tools', async () => {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
    const init = (await waitFor(1))['result'] as Record<string, unknown>
    expect(init['protocolVersion']).toBe('2025-06-18')
    expect((init['serverInfo'] as Record<string, unknown>)['name']).toBe('engram')

    send({ method: 'notifications/initialized' })
    send({ id: 2, method: 'tools/list' })
    const tools = ((await waitFor(2))['result'] as { tools: { name: string }[] }).tools.map((t) => t.name)
    expect(tools).toEqual(['engram_capture', 'engram_search', 'engram_context', 'engram_trace', 'engram_brief', 'engram_alias'])
  })

  it('engram_capture drops the text into the vault inbox', async () => {
    send({ id: 3, method: 'tools/call', params: { name: 'engram_capture', arguments: { text: '내일 김대리에게 배포 일정 회신하기' } } })
    const result = (await waitFor(3))['result'] as { content: { text: string }[]; isError?: boolean }
    expect(result.isError).toBeUndefined()
    // Multi-workspace safety: every answer names the workspace it touched.
    expect(result.content[0]!.text).toContain('workspace "')
    const files = (await readdir(paths.inbox)).filter((f) => f.endsWith('-capture.md'))
    expect(files.length).toBe(1)
    expect(await readFile(join(paths.inbox, files[0]!), 'utf8')).toContain('김대리')
  })

  it('malicious capture text cannot escape inbox/ — traversal/newlines land only in the body', async () => {
    // Path-traversal + injection payload as the capture text. The filename is
    // timestamp-only, so the payload can only ever become file CONTENT.
    const evil = '../../../etc/passwd\n../\\..\\windows\n# pwned\n<script>alert(1)</script>'
    send({ id: 15, method: 'tools/call', params: { name: 'engram_capture', arguments: { text: evil } } })
    const result = (await waitFor(15))['result'] as { isError?: boolean }
    expect(result.isError).toBeUndefined()
    // Every inbox entry is a safe timestamp-capture name — nothing derived from text.
    const entries = (await readdir(paths.inbox)).filter((f) => !f.startsWith('.'))
    for (const name of entries) expect(name).toMatch(/^[0-9TZ.-]+-capture\.md$/)
    // The payload survived as body content, proving text → content (never path).
    const captures = entries.filter((f) => f.endsWith('-capture.md'))
    const bodies = await Promise.all(captures.map((f) => readFile(join(paths.inbox, f), 'utf8')))
    expect(bodies.some((b) => b.includes('pwned'))).toBe(true)
  })

  it('safeInboxName rejects separators, traversal and NUL; passes a plain stamp name', () => {
    expect(safeInboxName('2026-07-21T09-00-00-000Z-capture.md')).toContain('-capture.md')
    for (const bad of ['../evil.md', '..\\evil.md', 'a/b.md', 'a\\b.md', '..', '.', 'x\0.md', 'sub/../../x']) {
      expect(() => safeInboxName(bad)).toThrow(/unsafe inbox filename/)
    }
  })

  it('engram_search and engram_context find the seeded decision', async () => {
    send({ id: 4, method: 'tools/call', params: { name: 'engram_search', arguments: { query: 'PG사 수수료' } } })
    const search = (await waitFor(4))['result'] as { content: { text: string }[] }
    expect(search.content[0]!.text).toContain('PG사 결정')

    send({ id: 5, method: 'tools/call', params: { name: 'engram_context', arguments: { query: '백업 보존' } } })
    const ctx = (await waitFor(5))['result'] as { content: { text: string }[] }
    expect(ctx.content[0]!.text).toContain('90일 보관')
  })

  it('engram_brief reports the workspace, waiting captures and the latest briefing', async () => {
    await writeFile(join(paths.views, 'brief-2026-07-20.md'), '# 오늘\n\n스윕 1회, 카드 0건.')
    await writeFile(join(paths.views, 'brief-2026-07-21.md'), '# 오늘\n\n결정 2건이 정리됨.')
    send({ id: 8, method: 'tools/call', params: { name: 'engram_brief', arguments: {} } })
    const brief = (await waitFor(8))['result'] as { content: { text: string }[] }
    const text = brief.content[0]!.text
    expect(text).toContain('workspace "')
    expect(text).toContain('2026-07-21')
    expect(text).toContain('결정 2건이 정리됨')
    expect(text).toMatch(/capture\(s\) waiting/)
  })

  it('engram_alias teaches an equivalence and search bridges it immediately', async () => {
    send({ id: 9, method: 'tools/call', params: { name: 'engram_alias', arguments: { terms: ['커미션', '수수료'] } } })
    const taught = (await waitFor(9))['result'] as { content: { text: string }[]; isError?: boolean }
    expect(taught.isError).toBeUndefined()
    expect(taught.content[0]!.text).toContain('커미션 = 수수료')

    send({ id: 10, method: 'tools/call', params: { name: 'engram_search', arguments: { query: '커미션 정산' } } })
    const bridged = (await waitFor(10))['result'] as { content: { text: string }[] }
    expect(bridged.content[0]!.text).toContain('PG사 결정')
    expect(bridged.content[0]!.text).toContain('expanded via the user\'s aliases')
  })

  it('prospective memory: a trigger note self-surfaces when its keyword comes up', async () => {
    // Lexically the query shares nothing with the note body except the trigger.
    send({ id: 11, method: 'tools/call', params: { name: 'engram_search', arguments: { query: '이번 주 배포 일정 정리' } } })
    const found = (await waitFor(11))['result'] as { content: { text: string }[] }
    expect(found.content[0]!.text).toContain('REMINDER')
    expect(found.content[0]!.text).toContain('캐시 무효화')
  })

  it('failed recalls are remembered: repeated zero-hit questions surface in the brief as gaps', async () => {
    send({ id: 12, method: 'tools/call', params: { name: 'engram_search', arguments: { query: '와이파이 공유기 관리자 비밀번호' } } })
    expect(((await waitFor(12))['result'] as { content: { text: string }[] }).content[0]!.text).toContain('memory gap')
    send({ id: 13, method: 'tools/call', params: { name: 'engram_search', arguments: { query: '공유기 관리자 비밀번호 와이파이' } } })
    await waitFor(13)
    send({ id: 14, method: 'tools/call', params: { name: 'engram_brief', arguments: {} } })
    const brief = ((await waitFor(14))['result'] as { content: { text: string }[] }).content[0]!.text
    expect(brief).toContain('Memory gaps')
    expect(brief).toContain('공유기')
    expect(brief).toContain('2×')
  })

  it('unknown methods get a -32601 error, bad tool calls a soft isError', async () => {
    send({ id: 6, method: 'resources/list' })
    const err = (await waitFor(6))['error'] as { code: number }
    expect(err.code).toBe(-32601)

    send({ id: 7, method: 'tools/call', params: { name: 'engram_capture', arguments: {} } })
    const bad = (await waitFor(7))['result'] as { isError?: boolean }
    expect(bad.isError).toBe(true)
  })
})
