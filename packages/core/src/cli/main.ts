import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { expandQueryWithAliases, loadAliasGroups } from '../aliases.js'
import { approveCard, listCards, rejectCard } from '../cards.js'
import { MockEngine } from '../engine/mock.js'
import { createEngine, detectAvailableEngines } from '../engine/registry.js'
import type { Engine, EngineId } from '../engine/types.js'
import { badgeOf } from '../freshness.js'
import { loadNotes } from '../notes.js'
import { startMcpServer } from '../mcp.js'
import { writeCapture } from '../capture.js'
import { processCapture, sweep } from '../jobs/sweep.js'
import { buildIndex, searchIndex } from '../search.js'
import { traceNote } from '../trace.js'
import { initVault, vaultPaths, type VaultPaths } from '../vault.js'

// `engram` CLI (BUILD_PLAN M2-6). The Electron app is a shell over the same
// core calls — everything here must work without any GUI.

export interface CliIO {
  out(line: string): void
  err(line: string): void
}

const defaultIO: CliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}

async function findVaultRoot(start: string): Promise<string | null> {
  let dir = resolve(start)
  for (;;) {
    try {
      await access(join(dir, 'workspace', 'AGENTS.md'))
      return dir
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }
}

async function requireVault(flag: string | undefined, io: CliIO): Promise<VaultPaths | null> {
  const root = flag ? resolve(flag) : await findVaultRoot(process.cwd())
  if (!root) {
    io.err('No vault found. Create one with `engram init`, or point at it with --vault.')
    return null
  }
  return vaultPaths(root)
}

async function resolveEngines(engineFlag: string | undefined, mockDir: string | undefined): Promise<Engine[]> {
  if (engineFlag === 'mock') {
    const dir = mockDir ?? process.env['ENGRAM_MOCK_DIR']
    return [dir ? await MockEngine.fromDir(dir) : new MockEngine()]
  }
  if (engineFlag && engineFlag !== 'auto') return [createEngine(engineFlag as EngineId)]
  return detectAvailableEngines()
}

export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      vault: { type: 'string' },
      engine: { type: 'string' },
      'mock-dir': { type: 'string' },
      full: { type: 'boolean' },
      private: { type: 'boolean' },
      'no-run': { type: 'boolean' },
      choose: { type: 'string' },
      action: { type: 'string' },
      reason: { type: 'string' },
      registry: { type: 'string' },
    },
  })
  const [command, ...rest] = positionals

  switch (command) {
    // MCP stdio server — stdout is the protocol channel, so nothing else may
    // print there. Runs until the client (Claude) closes stdin.
    case 'mcp': {
      await startMcpServer(process.stdin, process.stdout, {
        vaultRoot: values.vault ? resolve(values.vault) : undefined,
        registryPath: values.registry ? resolve(values.registry) : undefined,
      })
      return 0
    }

    case 'init': {
      const root = resolve(rest[0] ?? process.cwd())
      const paths = await initVault(root)
      io.out(`vault created: ${paths.root}`)
      io.out('workspace/ (notes, inbox, sources, _views) and private/ are ready.')
      return 0
    }

    case 'capture': {
      const paths = await requireVault(values.vault, io)
      if (!paths) return 1
      const input = rest.join(' ').trim()
      if (!input) {
        io.err('usage: engram capture <text|file path>')
        return 1
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      let fileName: string
      const asPath = isAbsolute(input) ? input : resolve(process.cwd(), input)
      const isFile = await access(asPath).then(() => true, () => false)
      if (values.private) {
        await mkdir(paths.privateDir, { recursive: true })
        const target = join(paths.privateDir, isFile ? basename(asPath) : `${stamp}-capture.md`)
        if (isFile) await copyFile(asPath, target)
        else await writeFile(target, input + '\n')
        io.out(`🔒 saved to private: ${target}`)
        io.out('private entries are never passed to any engine.')
        return 0
      }
      if (isFile) {
        fileName = basename(asPath)
        await copyFile(asPath, join(paths.inbox, fileName))
      } else {
        const written = await writeCapture(paths.inbox, input)
        fileName = written.file
        if (written.duplicate) {
          io.out(`the same content is already in the inbox: ${fileName}`)
          return 0
        }
      }
      io.out(`captured to inbox: ${fileName}`)
      if (values['no-run']) return 0
      const engines = await resolveEngines(values.engine, values['mock-dir'])
      if (engines.length === 0) {
        io.out('no engine available — it waits in the inbox (a sweep picks it up once one is connected).')
        return 0
      }
      const report = await processCapture(paths, engines)
      io.out(`librarian done: ${report.executed} run · ${report.skipped} skipped · ${report.failed.length} failed`)
      return report.failed.length > 0 ? 1 : 0
    }

    case 'sweep': {
      const paths = await requireVault(values.vault, io)
      if (!paths) return 1
      const engines = await resolveEngines(values.engine, values['mock-dir'])
      if (engines.length === 0) {
        io.err('no engine available. Check that a local model is downloaded, or that the CLI engine is logged in.')
        return 1
      }
      const report = await sweep(paths, engines, { full: values.full })
      io.out(
        `sweep done: ${report.executed} run · ${report.skipped} skipped · ${report.failed.length} failed · ${report.deferred} deferred` +
          (report.substitutedTo ? ` · substituted to ${report.substitutedTo}` : '') +
          (report.briefWritten ? ' · brief written' : ''),
      )
      for (const failure of report.failed) io.err(`failed: ${failure.kind} ${failure.inputKey} — ${failure.error}`)
      return 0
    }

    case 'cards': {
      const paths = await requireVault(values.vault, io)
      if (!paths) return 1
      const [sub, id] = rest
      if (sub === 'list' || sub === undefined) {
        const cards = await listCards(paths, 'proposed')
        if (cards.length === 0) {
          io.out('no cards to review.')
          return 0
        }
        for (const card of cards) {
          io.out(`${card.id}  [${card.cardType}]  ${card.targets.join(', ')}`)
          io.out(`    rationale: ${card.rationale}`)
        }
        return 0
      }
      if (!id) {
        io.err('usage: engram cards approve|reject <card id>')
        return 1
      }
      if (sub === 'approve') {
        const card = await approveCard(paths, id, {
          choice: values.choose as 'A' | 'B' | 'both' | undefined,
          action: values.action as 'keep' | 'retire' | undefined,
        })
        io.out(`approved: ${card.id} [${card.cardType}] → ${card.targets.join(', ')}`)
        return 0
      }
      if (sub === 'reject') {
        const card = await rejectCard(paths, id, values.reason ?? 'no reason given')
        io.out(`rejected: ${card.id} — recorded in the AGENTS.md counterexamples.`)
        return 0
      }
      io.err(`unknown subcommand: ${sub}`)
      return 1
    }

    case 'search': {
      const paths = await requireVault(values.vault, io)
      if (!paths) return 1
      const query = rest.join(' ').trim()
      if (!query) {
        io.err('usage: engram search <query>')
        return 1
      }
      const notes = await loadNotes(paths)
      const hits = searchIndex(buildIndex(notes), expandQueryWithAliases(query, await loadAliasGroups(paths)))
      if (hits.length === 0) {
        io.out('no matches.')
        return 0
      }
      const byId = new Map(notes.map((n) => [n.front.id, n]))
      for (const hit of hits.slice(0, 20)) {
        const note = byId.get(hit.id)
        io.out(`${note ? badgeOf(note) : ''} ${hit.id}  ${hit.title}  (${hit.status})`)
      }
      return 0
    }

    case 'trace': {
      const paths = await requireVault(values.vault, io)
      if (!paths) return 1
      const ref = rest.join(' ').trim()
      if (!ref) {
        io.err('usage: engram trace <note id | query>')
        return 1
      }
      const notes = await loadNotes(paths)
      let seedId = ref
      if (!notes.some((n) => n.front.id === ref)) {
        const hits = searchIndex(buildIndex(notes), expandQueryWithAliases(ref, await loadAliasGroups(paths)))
        if (hits.length === 0 || !hits[0]) {
          io.out('no memory to trace.')
          return 0
        }
        seedId = hits[0].id
      }
      const map = traceNote(notes, seedId)
      io.out(map ?? 'no note with that id.')
      return map ? 0 : 1
    }

    case undefined:
    case 'help': {
      io.out('engram — a local knowledge librarian')
      io.out('commands: init [path] · capture <text|file> · sweep [--full] · cards list|approve|reject <id> · search <query> · trace <id|query> · mcp')
      io.out('options: --vault <path> · --engine claude|mock|auto · --private · --full · --registry <vaults.json> (mcp)')
      return command === undefined ? 1 : 0
    }

    default: {
      io.err(`unknown command: ${command}`)
      return 1
    }
  }
}
