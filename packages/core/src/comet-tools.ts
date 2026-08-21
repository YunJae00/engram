import { createCard } from './cards.js'
import { readNote } from './notes.js'
import { noteTitle } from './schema.js'
import type { VaultPaths } from './vault.js'
import type { AgentTool } from './agent-loop.js'
import { listRoutines, routineStepLabel } from './routine.js'
import type { ErrandRetrievedNote } from './errand.js'

// The comet's standard toolbox. Reading is free; writing is NEVER direct —
// the only write-shaped tool files a review card, so nothing lands in the
// vault without the person's approval. The vault is the sub-wiki here: the
// place the comet looks before it invents.

export interface CometToolDeps {
  paths: VaultPaths
  retrieve(query: string, limit: number): Promise<ErrandRetrievedNote[]>
}

const RESULTS_CAP = 5
const BODY_EXCERPT = 300
const PROPOSE_BODY_CAP = 8_000

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function cometTools(deps: CometToolDeps): AgentTool[] {
  return [
    {
      name: 'search_memory',
      description: "search the person's vault for notes about a topic — args: {\"query\": \"...\"}",
      argsSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async run(args) {
        const query = str(args, 'query')
        if (!query) return 'search_memory needs a query'
        const hits = await deps.retrieve(query, RESULTS_CAP)
        if (hits.length === 0) return `nothing in the vault about "${query}"`
        return hits.map((h) => `[${h.title}] (id: ${h.id}) ${h.body.slice(0, BODY_EXCERPT)}`).join('\n')
      },
    },
    {
      name: 'read_note',
      description: 'read one note in full by its id — args: {"id": "n-..."}',
      argsSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(args) {
        const id = str(args, 'id')
        if (!id) return 'read_note needs an id'
        try {
          const note = await readNote(deps.paths, id)
          return `# ${noteTitle(note)}\n${note.body.slice(0, 2_000)}`
        } catch {
          return `no note with id "${id.slice(0, 40)}"`
        }
      },
    },
    {
      name: 'find_procedure',
      description: 'look for a saved procedure (routine) matching a task — args: {"task": "..."}',
      argsSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
      async run(args) {
        const task = str(args, 'task').toLowerCase()
        const routines = await listRoutines(deps.paths)
        if (routines.length === 0)
          return 'no procedures are saved yet — the person can teach one in Routines ("Teach it by doing")'
        const words = task.split(/\s+/).filter((w) => w.length > 1)
        const scored = routines
          .map((r) => ({
            r,
            score: words.filter((w) => r.name.toLowerCase().includes(w)).length,
          }))
          .sort((a, b) => b.score - a.score)
        const best = scored[0]!
        if (best.score === 0)
          return `no saved procedure matches "${task.slice(0, 60)}" — suggest teaching it once in Routines`
        const steps = best.r.steps.map((s, i) => `${i + 1}. ${routineStepLabel(s)}`).join('; ')
        return `found "${best.r.name}" (run it from Routines): ${steps}`
      },
    },
    {
      name: 'propose_note',
      description: 'propose saving a note — it becomes a review card the person approves — args: {"title": "...", "body": "..."}',
      argsSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' } },
        required: ['title', 'body'],
      },
      async run(args) {
        const title = str(args, 'title')
        const body = str(args, 'body')
        if (!title || !body) return 'propose_note needs a title and a body'
        const card = await createCard(deps.paths, {
          cardType: 'new-note',
          targets: [],
          rationale: `comet: ${title}`.slice(0, 160),
          proposed: `# ${title}\n\n${body}`.slice(0, PROPOSE_BODY_CAP),
          job: 'J1',
        })
        return `proposed — waiting for the person's approval in review (card ${card.id})`
      },
    },
  ]
}
