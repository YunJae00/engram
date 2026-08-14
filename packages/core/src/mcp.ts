import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { activationRerank, spreadActivation, triggeredNotes } from './activation.js'
import { addAliasGroup, expandQueryWithAliases, loadAliasGroups } from './aliases.js'
import { recordRecallMiss, repeatedRecallMisses } from './misses.js'
import { loadNotes, recordRecall } from './notes.js'
import { countRecallReceipts, recordRecallReceipt } from './receipts.js'
import { writeCapture } from './capture.js'
import { noteTitle, type Note } from './schema.js'
import { buildIndex, searchIndex } from './search.js'
import { traceNote } from './trace.js'
import { vaultPaths, type VaultPaths } from './vault.js'

export interface McpOptions {
  // Explicit vault root wins; otherwise the workspace registry (vaults.json,
  // written by the desktop app) names the current vault — re-read per call so
  // a workspace switch in the app is picked up without reconnecting.
  vaultRoot?: string
  registryPath?: string
}

interface RpcMessage {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

const SEARCH_CACHE_TTL_MS = 30_000
const PROTOCOL_FALLBACK = '2024-11-05'

const TOOLS = [
  {
    name: 'engram_capture',
    description:
      "Save a thought, decision, request or fact into the user's Engram second brain. Use when the user says things like 'remember this' or when a durable fact/decision emerges that they would want kept. The librarian files it later — just capture the raw text.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The content to remember, as plain text or markdown.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'engram_search',
    annotations: { readOnlyHint: true },
    description:
      "Search the user's Engram second brain (their personal notes, decisions and memories). Returns matching note titles with ids, status and short excerpts. Use to check what the user already knows or decided.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (Korean or English).' },
        limit: { type: 'number', description: 'Max results (default 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'engram_context',
    annotations: { readOnlyHint: true },
    description:
      "Retrieve full context from the user's Engram second brain for a question: the top matching notes with their bodies and why they are linked. Use before answering questions about the user's past decisions, projects or knowledge.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question or topic to ground.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'engram_trace',
    annotations: { readOnlyHint: true },
    description:
      "Walk the user's memory graph from one note: its links (each labeled with WHY the librarian connected them), the supersede lineage (what this replaced and what replaced it), its topic hub, and other memories from the same folder. Use after engram_search to explore around a hit, or to answer 'why / since when / what changed / what else was decided there'. Cheaper than engram_context — a map, not bodies.",
    inputSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: "A note id ('n-...') from a previous result, or a search phrase — the top hit gets traced.",
        },
      },
      required: ['note'],
    },
  },
  {
    name: 'engram_brief',
    annotations: { readOnlyHint: true },
    description:
      "Get the current state of the user's Engram second brain: the active workspace, how many captures await the librarian, the note count, and the librarian's latest daily briefing. Use when the user asks for their brief, what's new, or the status of their brain.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'engram_alias',
    description:
      "Record that two or more names refer to the same thing in the user's world (a project and its codename, Korean/English spellings, 'myclient' = 'myclientology'). Use when the user says X and Y are the same thing. Search and the librarian then treat all the names as one.",
    inputSchema: {
      type: 'object',
      properties: {
        terms: {
          type: 'array',
          items: { type: 'string' },
          description: 'The equivalent names (2 or more), e.g. ["myclient", "myclientology"].',
        },
      },
      required: ['terms'],
    },
  },
] as const

interface SearchCache {
  root: string
  builtAt: number
  notes: Note[]
  index: ReturnType<typeof buildIndex>
  aliases: string[][]
}

let cache: SearchCache | null = null

// Every answer names the workspace it touched — with multiple workspaces a
// capture that silently lands in the wrong one is data loss by surprise.
interface ResolvedVault {
  paths: VaultPaths
  workspace: string
}

async function resolveVault(opts: McpOptions): Promise<ResolvedVault> {
  if (opts.vaultRoot) {
    const paths = vaultPaths(resolve(opts.vaultRoot))
    return { paths, workspace: basename(paths.root) }
  }
  if (opts.registryPath) {
    const reg = JSON.parse(await readFile(opts.registryPath, 'utf8')) as {
      current: string | null
      vaults: { id: string; name?: string; root: string }[]
    }
    const current = reg.vaults.find((v) => v.id === reg.current)
    if (current) return { paths: vaultPaths(current.root), workspace: current.name ?? basename(current.root) }
    throw new Error('no current workspace in the registry — open the Engram app once')
  }
  const envRoot = process.env['ENGRAM_VAULT']
  if (envRoot) {
    const paths = vaultPaths(resolve(envRoot))
    return { paths, workspace: basename(paths.root) }
  }
  throw new Error('no vault configured (pass --vault or --registry)')
}

async function indexFor(paths: VaultPaths): Promise<SearchCache> {
  const now = Date.now()
  if (cache && cache.root === paths.root && now - cache.builtAt < SEARCH_CACHE_TTL_MS) return cache
  const notes = (await loadNotes(paths)).filter(
    (n) => n.front.status === 'current' || n.front.status === 'disputed',
  )
  cache = { root: paths.root, builtAt: now, notes, index: buildIndex(notes), aliases: await loadAliasGroups(paths) }
  return cache
}

function excerptOf(note: Note, chars: number): string {
  return note.body.replace(/^#.*$/m, '').trim().replace(/\s+/g, ' ').slice(0, chars)
}

// The capture filename is built ONLY from a timestamp — no capture text or MCP
// argument ever reaches it, so path traversal is impossible by construction.
// This guard locks that invariant: any future change that let user input into
// the name (separators, .., NUL) fails loudly instead of writing outside inbox/.
export function safeInboxName(name: string): string {
  if (name !== basename(name) || /[\\/\0]/.test(name) || name === '.' || name === '..' || name.includes('..')) {
    throw new Error(`unsafe inbox filename: ${JSON.stringify(name)}`)
  }
  return name
}

function captureContext(): string | undefined {
  const cwd = process.cwd()
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  if (!cwd || (home && resolve(cwd) === resolve(home))) return undefined
  if (/AppData|Program Files|AnthropicClaude|[\\/]Applications[\\/]|^\/usr\b/i.test(cwd)) return undefined
  const label = basename(cwd)
  // Versioned install dirs ("app-1.24012.9") are packaging, not projects.
  if (!label || /^app-[\d.]+$/i.test(label)) return undefined
  return label
}
const CWD_LABEL = captureContext()

function foldSameFolderFirst<T extends { id: string }>(hits: T[], byId: Map<string, Note>): T[] {
  if (!CWD_LABEL) return hits
  const here = hits.filter((h) => byId.get(h.id)?.front.context === CWD_LABEL)
  return here.length === 0 ? hits : [...here, ...hits.filter((h) => byId.get(h.id)?.front.context !== CWD_LABEL)]
}

const folderTag = (note: Note | undefined): string =>
  note?.front.context ? `, folder: ${note.front.context}` : ''

async function runCapture({ paths, workspace }: ResolvedVault, text: string): Promise<string> {
  await mkdir(paths.inbox, { recursive: true })
  // An agent retrying a tool call must not leave two copies of one memory.
  const { file, duplicate } = await writeCapture(paths.inbox, text, 'user', CWD_LABEL)
  const fileName = safeInboxName(file)
  if (duplicate) {
    return `Already captured to Engram workspace "${workspace}" (${fileName}) — identical text was still waiting to be filed, so nothing was duplicated. Nothing else to do.`
  }
  return `Captured to Engram workspace "${workspace}" (${fileName}). The librarian will file it — nothing else to do. If that is the wrong workspace, tell the user to switch it in the Engram app and recapture.`
}

async function runSearch({ paths, workspace }: ResolvedVault, query: string, limit: number): Promise<string> {
  const { notes, index, aliases } = await indexFor(paths)
  const byId = new Map(notes.map((n) => [n.front.id, n]))
  const expanded = expandQueryWithAliases(query, aliases)
  // Prospective memory first: a trigger match outranks (and absorbs) a plain
  // lexical hit so the REMINDER framing always survives.
  const woken = triggeredNotes(expanded, notes)
  const wokenIds = new Set(woken.map((n) => n.front.id))
  const hits = foldSameFolderFirst(
    activationRerank(
      searchIndex(index, expanded).filter((h) => !wokenIds.has(h.id)),
      (id) => byId.get(id),
    ),
    byId,
  ).slice(0, limit)
  const aliasNote = expanded !== query ? ` (query expanded via the user's aliases: "${expanded}")` : ''
  if (hits.length === 0 && woken.length === 0) {
    // The brain remembers what it could NOT answer — repeated gaps surface in the brief.
    await recordRecallMiss(paths, query).catch(() => {})
    return `No matches in workspace "${workspace}" for "${query}"${aliasNote}. (Search follows the workspace active in the Engram app.) If the user finds the answer elsewhere, offer to capture it — this question has now been recorded as a memory gap.`
  }
  const lines = hits.map((hit) => {
    const note = byId.get(hit.id)
    const date = note?.front.happened_at?.slice(0, 10) ?? note?.front.updated.slice(0, 10) ?? ''
    return `- [${hit.title}] (id: ${hit.id}, status: ${hit.status}${date ? `, ${date}` : ''}${folderTag(note)})\n  ${note ? excerptOf(note, 160) : ''}`
  })
  for (const note of woken.slice(0, 3)) {
    lines.unshift(
      `- [${noteTitle(note)}] (id: ${note.front.id}, REMINDER — the user asked to be reminded of this when "${(note.front.triggers ?? []).join('/')}" comes up)\n  ${excerptOf(note, 160)}`,
    )
  }
  // Receipts + sky glow: memories served to a model count as recalled — the
  // brief turns these into "Claude drew on your memories N times this week".
  const served = [...woken.slice(0, 3).map((n) => n.front.id), ...hits.map((h) => h.id)]
  void (async () => {
    for (const id of served) await recordRecall(paths, id).catch(() => {})
    await recordRecallReceipt(paths, 'mcp-search', served).catch(() => {})
  })()
  return `${hits.length + Math.min(woken.length, 3)} matches in workspace "${workspace}"${aliasNote}:\n${lines.join('\n')}`
}

// The map, not the bodies (see trace.ts). The ref is an id when the agent is
// walking, a phrase when it is starting out — the top search hit seeds it.
async function runTrace({ paths, workspace }: ResolvedVault, ref: string): Promise<string> {
  const { notes, index, aliases } = await indexFor(paths)
  let seedId = ref
  if (!notes.some((n) => n.front.id === ref)) {
    const expanded = expandQueryWithAliases(ref, aliases)
    const byId = new Map(notes.map((n) => [n.front.id, n]))
    const top = foldSameFolderFirst(searchIndex(index, expanded), byId)[0]
    if (!top) {
      await recordRecallMiss(paths, ref).catch(() => {})
      return `No memory in workspace "${workspace}" matches "${ref}" — nothing to trace. This question was recorded as a memory gap.`
    }
    seedId = top.id
  }
  const map = traceNote(notes, seedId)
  if (!map) return `Note ${seedId} was not found in workspace "${workspace}".`
  void (async () => {
    await recordRecall(paths, seedId).catch(() => {})
    await recordRecallReceipt(paths, 'mcp-trace', [seedId]).catch(() => {})
  })()
  return `Memory graph around ${seedId} (workspace "${workspace}"):\n${map}\nWalk further: engram_trace any id above. Read a body: engram_context.`
}

async function runContext({ paths, workspace }: ResolvedVault, query: string): Promise<string> {
  const { notes, index, aliases } = await indexFor(paths)
  const byId = new Map(notes.map((n) => [n.front.id, n]))
  const expanded = expandQueryWithAliases(query, aliases)
  const hits = foldSameFolderFirst(activationRerank(searchIndex(index, expanded), (id) => byId.get(id)), byId).slice(0, 5)
  const woken = triggeredNotes(expanded, notes)
  if (hits.length === 0 && woken.length === 0) {
    await recordRecallMiss(paths, query).catch(() => {})
    return `The user's Engram workspace "${workspace}" has no notes matching "${query}". (Search follows the workspace active in the Engram app.) This question was recorded as a memory gap — if the answer emerges, offer to capture it.`
  }
  const entry = (note: Note, marker?: string): string => {
    const links = Object.entries(note.front.link_reasons ?? {})
      .map(([id, reason]) => {
        const other = byId.get(id)
        return other ? `\n> connected → [${noteTitle(other)}]: ${reason}` : ''
      })
      .join('')
    return `[${noteTitle(note)}] (id: ${note.front.id}, status: ${note.front.status}${marker ? `, ${marker}` : ''})${links}\n${note.body.trim().slice(0, 2000)}`
  }
  const included = new Set<string>()
  const entries: string[] = []
  // Prospective memories fire first — the user explicitly asked to be reminded.
  for (const note of woken.slice(0, 2)) {
    included.add(note.front.id)
    entries.push(entry(note, `REMINDER the user set for "${(note.front.triggers ?? []).join('/')}"`))
  }
  for (const hit of hits) {
    const note = byId.get(hit.id)
    if (!note || included.has(note.front.id)) continue
    included.add(note.front.id)
    entries.push(entry(note))
  }
  const seeds = new Map(hits.map((h) => [h.id, h.score]))
  for (const assoc of spreadActivation(seeds, notes, new Date(), { limit: 4 })) {
    if (included.has(assoc.id)) continue
    const note = byId.get(assoc.id)
    if (!note) continue
    included.add(assoc.id)
    const via = byId.get(assoc.via)
    entries.push(entry(note, `came to mind via [${via ? noteTitle(via) : assoc.via}]`))
  }
  void (async () => {
    for (const id of included) await recordRecall(paths, id).catch(() => {})
    await recordRecallReceipt(paths, 'mcp-context', [...included]).catch(() => {})
  })()
  return `--- Engram context (workspace "${workspace}") ---\n${entries.join('\n\n')}`
}

async function runBrief({ paths, workspace }: ResolvedVault): Promise<string> {
  let waiting = 0
  try {
    waiting = (await readdir(paths.inbox)).filter((f) => !f.startsWith('.')).length
  } catch {
    /* no inbox yet */
  }
  const { notes } = await indexFor(paths)
  const lines = [
    `Engram workspace "${workspace}" — ${notes.length} living notes, ${waiting} capture(s) waiting for the librarian.`,
  ]
  // The receipt line: the week's served-memory count, so the value of having
  // a vault stops being invisible.
  const receipts = await countRecallReceipts(paths, Date.now() - 7 * 86_400_000).catch(() => ({ total: 0, topIds: [] as [string, number][] }))
  if (receipts.total > 0) {
    lines.push(`This week, assistants drew on these memories ${receipts.total} time(s).`)
  }
  if (CWD_LABEL) {
    const here = notes.filter((n) => n.front.context === CWD_LABEL)
    if (here.length > 0) {
      const newest = here.sort((a, b) => Date.parse(b.front.updated) - Date.parse(a.front.updated))[0]!
      lines.push(`Current folder "${CWD_LABEL}": ${here.length} memories from here — newest: [${noteTitle(newest)}] (${newest.front.id}).`)
    }
  }
  try {
    const briefs = (await readdir(paths.views))
      .filter((f) => /^brief-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
    const latest = briefs[briefs.length - 1]
    if (latest) {
      const body = (await readFile(join(paths.views, latest), 'utf8')).trim().slice(0, 2500)
      lines.push(`\nLatest briefing (${latest.slice(6, 16)}):\n${body}`)
    } else {
      lines.push('No briefing written yet — the librarian writes one after its next tidy.')
    }
  } catch {
    lines.push('No briefing written yet — the librarian writes one after its next tidy.')
  }
  // Metamemory: gaps the user keeps reaching for. The brain knows what it
  // does NOT know — repeated zero-hit questions become capture suggestions.
  const gaps = await repeatedRecallMisses(paths).catch(() => [])
  if (gaps.length > 0) {
    lines.push(
      '\nMemory gaps (questions asked repeatedly with no matching note — suggest capturing the answers):',
      ...gaps.map((g) => `- "${g.query}" (asked ${g.count}×, last ${g.last.slice(0, 10)})`),
    )
  }
  return lines.join('\n')
}

async function callTool(opts: McpOptions, name: string, args: Record<string, unknown>): Promise<string> {
  const vault = await resolveVault(opts)
  switch (name) {
    case 'engram_brief':
      return runBrief(vault)
    case 'engram_capture': {
      const text = String(args['text'] ?? '').trim()
      if (!text) throw new Error('text is required')
      return runCapture(vault, text)
    }
    case 'engram_search': {
      const query = String(args['query'] ?? '').trim()
      if (!query) throw new Error('query is required')
      const limit = Math.min(Math.max(Number(args['limit']) || 8, 1), 25)
      return runSearch(vault, query, limit)
    }
    case 'engram_context': {
      const query = String(args['query'] ?? '').trim()
      if (!query) throw new Error('query is required')
      return runContext(vault, query)
    }
    case 'engram_trace': {
      const ref = String(args['note'] ?? '').trim()
      if (!ref) throw new Error('note is required')
      return runTrace(vault, ref)
    }
    case 'engram_alias': {
      const terms = (Array.isArray(args['terms']) ? args['terms'] : []).map((t) => String(t))
      const group = await addAliasGroup(vault.paths, terms)
      if (!group) throw new Error('terms needs 2 or more distinct names (each 2+ characters)')
      cache = null // next search sees the new equivalence immediately
      return `Recorded in workspace "${vault.workspace}": ${group.join(' = ')}. Search and the librarian now treat these names as the same thing (workspace/aliases.md).`
    }
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

// Runs until the input stream closes (the client owns the process lifetime).
export function startMcpServer(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  opts: McpOptions = {},
): Promise<void> {
  const send = (msg: Record<string, unknown>) => output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

  const handle = async (msg: RpcMessage): Promise<void> => {
    const { id, method, params } = msg
    // Notifications (no id) never get a response.
    if (method?.startsWith('notifications/')) return
    if (id === undefined || id === null || !method) return
    try {
      if (method === 'initialize') {
        const requested = typeof params?.['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : PROTOCOL_FALLBACK
        send({
          id,
          result: {
            protocolVersion: requested,
            capabilities: { tools: {} },
            serverInfo: { name: 'engram', version: '0.1.0' },
            // Free steering for every client, not just the ones with a system
            // prompt we control: this rides the MCP handshake itself.
            instructions:
              "Engram is the user's second brain — their real decisions, projects and memories, kept locally. " +
              'BEFORE answering anything about their past work, decisions, or preferences, call engram_search or engram_context. ' +
              'Use engram_trace to walk relations from a hit (what replaced what, why things are linked). ' +
              'When a durable fact or decision emerges, offer to engram_capture it. ' +
              'Search ranks memories from the current working folder first.',
          },
        })
      } else if (method === 'ping') {
        send({ id, result: {} })
      } else if (method === 'tools/list') {
        send({ id, result: { tools: TOOLS } })
      } else if (method === 'tools/call') {
        const name = String(params?.['name'] ?? '')
        const args = (params?.['arguments'] ?? {}) as Record<string, unknown>
        try {
          const text = await callTool(opts, name, args)
          send({ id, result: { content: [{ type: 'text', text }] } })
        } catch (err) {
          send({ id, result: { content: [{ type: 'text', text: `Engram error: ${String((err as Error).message ?? err)}` }], isError: true } })
        }
      } else {
        send({ id, error: { code: -32601, message: `method not found: ${method}` } })
      }
    } catch (err) {
      send({ id, error: { code: -32603, message: String((err as Error).message ?? err) } })
    }
  }

  return new Promise((resolvePromise) => {
    const rl = createInterface({ input })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        void handle(JSON.parse(trimmed) as RpcMessage)
      } catch {
        // Unparseable line — a request id is unknowable, so stay silent.
      }
    })
    rl.on('close', () => resolvePromise())
  })
}
