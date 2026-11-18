import { readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { collectResult, engineCwd, PrivatePathError, type Engine, type EngineCwd } from '../src/engine/types.js'
import { GitLayer } from '../src/git.js'
import { startMcpServer } from '../src/mcp.js'
import { createNote, loadNotes } from '../src/notes.js'
import { serializeNote } from '../src/schema.js'
import { NoteStore } from '../src/store.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

describe('private physical separation', () => {
  it('collectResult refuses private paths regardless of engine', async () => {
    const paths = await initVault(await tmpVaultRoot('private-collect'), { git: false })
    const fake: Engine = {
      id: 'mock',
      detect: async () => ({ installed: true, loggedIn: true }),
      async *run() {
        yield { type: 'result', text: 'should never stream' }
      },
    }
    await expect(
      collectResult(fake, { prompt: 'x', workdir: paths.privateDir as EngineCwd }),
    ).rejects.toBeInstanceOf(PrivatePathError)
  })

  it('engineCwd() is the only blessed constructor and validates the layout', async () => {
    const paths = await initVault(await tmpVaultRoot('private-cwd'), { git: false })
    expect(engineCwd(paths)).toBe(paths.workspace)
    expect(() => engineCwd({ workspace: paths.privateDir, privateDir: paths.privateDir })).toThrow(PrivatePathError)
  })

  it('a nested path that merely contains "private" as a segment is caught', async () => {
    const fake: Engine = {
      id: 'mock',
      detect: async () => ({ installed: true, loggedIn: true }),
      async *run() {
        yield { type: 'result', text: 'x' }
      },
    }
    await expect(
      collectResult(fake, { prompt: 'x', workdir: '/vault/private/inner' as EngineCwd }),
    ).rejects.toBeInstanceOf(PrivatePathError)
  })
})

const CANARY = 'PRIVATE_CANARY_DO_NOT_LEAK_7F3A'
const CONTROL = 'WORKSPACE_VISIBLE_MEMO_2C9B'
const NOW = new Date('2026-07-21T09:00:00Z')

function privateNoteMarkdown(): string {
  return serializeNote({
    front: {
      id: 'n-canary-9999',
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      timeline: 'inferred',
      created: NOW.toISOString(),
      updated: NOW.toISOString(),
    },
    body: `# ${CANARY}\n\nThis ${CANARY} secret must never leave private/.`,
  })
}

async function seedVault(prefix: string, git: boolean): Promise<VaultPaths> {
  const paths = await initVault(await tmpVaultRoot(prefix), { git })
  await createNote(paths, { body: `# ${CONTROL}\n\nA normal workspace memory.` }, NOW)
  await writeFile(join(paths.privateDir, 'n-canary-9999.md'), privateNoteMarkdown())
  await writeFile(join(paths.privateDir, 'raw-secret.txt'), `${CANARY}\n`)
  return paths
}

describe('private/ is never read by any note consumer', () => {
  it('loadNotes reads workspace/notes only — the private note is never loaded', async () => {
    const paths = await seedVault('private-load', false)
    const notes = await loadNotes(paths)
    const blob = JSON.stringify(notes)
    expect(blob).toContain(CONTROL)
    expect(blob).not.toContain(CANARY)
    expect(notes.some((n) => n.front.id === 'n-canary-9999')).toBe(false)
  })

  it('NoteStore search + getAll exclude private (this is the embedding source)', async () => {
    const paths = await seedVault('private-store', false)
    const store = await NoteStore.open(paths)
    const all = store.getAll()
    expect(all.some((n) => n.body.includes(CONTROL))).toBe(true)
    expect(all.some((n) => n.body.includes(CANARY))).toBe(false)
    expect(all.some((n) => n.front.id === 'n-canary-9999')).toBe(false)
    const hits = store.search(CANARY)
    expect(hits.some((h) => h.id === 'n-canary-9999' || h.title.includes(CANARY))).toBe(false)
    expect(store.search(CONTROL).length).toBeGreaterThan(0)
  })

  it('even if a private path is fed to the store, it is rejected (dir guard)', async () => {
    const paths = await seedVault('private-apply', false)
    const store = await NoteStore.open(paths)
    const delta = await store.applyFile('add', join(paths.privateDir, 'n-canary-9999.md'))
    expect(delta.upserts).toEqual([])
    expect(delta.removed).toEqual([])
    expect(store.get('n-canary-9999')).toBeNull()
  })

  it('job-input surfaces (inbox + notes, what every librarian job reads) exclude private', async () => {
    const paths = await seedVault('private-jobs', false)
    const inbox = await readdir(paths.inbox)
    const sources = await readdir(paths.sources)
    for (const name of [...inbox, ...sources]) expect(name).not.toContain('canary')
    const notes = await loadNotes(paths)
    for (const note of notes) expect(note.body).not.toContain(CANARY)
  })
})

describe('private/ is outside the git repo and is never committed', () => {
  it('git ls-files never lists the private note, even after autoCommit -A', async () => {
    const paths = await seedVault('private-git', true)
    const rel = relative(paths.workspace, paths.privateDir)
    expect(rel.startsWith('..') || isAbsolute(rel)).toBe(true)

    const git = new GitLayer(paths.workspace)
    await git.autoCommit('vault: seed control note')
    const tracked = await git.raw(['ls-files'])
    expect(tracked).toContain('notes/')
    expect(tracked).not.toContain('private')
    expect(tracked).not.toContain('canary')
    await expect(git.raw(['add', resolve(paths.privateDir)])).rejects.toBeTruthy()
    const head = await git.raw(['log', '-p', '--all'])
    expect(head).not.toContain(CANARY)
  }, 120_000)
})

describe('private/ never appears in MCP tool output', () => {
  it('capture stays in the inbox; search/context/brief never surface the private note', async () => {
    const paths = await seedVault('private-mcp', false)

    const input = new PassThrough()
    const output = new PassThrough()
    const responses: Record<string | number, Record<string, unknown>> = {}
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

    const send = (msg: Record<string, unknown>) => input.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
    const waitFor = async (id: number): Promise<Record<string, unknown>> => {
      const start = Date.now()
      for (;;) {
        if (responses[id]) return responses[id]!
        if (Date.now() - start > 5000) throw new Error(`no response for id ${id}`)
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    const textOf = (r: Record<string, unknown>): string =>
      ((r['result'] as { content?: { text?: string }[] })?.content?.[0]?.text ?? '')

    send({ id: 1, method: 'tools/call', params: { name: 'engram_search', arguments: { query: CANARY } } })
    const search = textOf(await waitFor(1))
    expect(search).not.toContain(CANARY)
    expect(search).not.toContain('n-canary-9999')

    send({ id: 2, method: 'tools/call', params: { name: 'engram_search', arguments: { query: CONTROL } } })
    expect(textOf(await waitFor(2))).toContain(CONTROL)

    send({ id: 3, method: 'tools/call', params: { name: 'engram_context', arguments: { query: CANARY } } })
    const ctx = textOf(await waitFor(3))
    expect(ctx).not.toContain(CANARY)
    expect(ctx).not.toContain('n-canary-9999')

    send({ id: 4, method: 'tools/call', params: { name: 'engram_brief', arguments: {} } })
    const brief = textOf(await waitFor(4))
    expect(brief).not.toContain(CANARY)
    expect(brief).toContain('1 living notes')

    send({ id: 5, method: 'tools/call', params: { name: 'engram_capture', arguments: { text: 'a fresh thought' } } })
    await waitFor(5)
    expect((await readdir(paths.inbox)).some((f) => f.endsWith('-capture.md'))).toBe(true)
    expect((await readdir(paths.privateDir)).some((f) => f.endsWith('-capture.md'))).toBe(false)

    input.end()
  })
})
