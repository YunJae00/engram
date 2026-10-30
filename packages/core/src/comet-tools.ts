import { navigationTools } from './comet-navigation-tools.js'
export { snippetFor, looksLikeSearchFor, isResultsPage } from './comet-navigation-tools.js'
import { type DecidePage } from './page-do.js'
import { createCard } from './cards.js'
import { readNote } from './notes.js'
import { noteTitle, type Note } from './schema.js'
import type { VaultPaths } from './vault.js'
import type { AgentTool } from './agent-loop.js'
import { listRoutines, routineSlotExamples, routineSlots, routineStepLabel } from './routine.js'
import { annotateStaleCards, listSkills, relevantSkillCards, readSkillFile, readSkillsLedger, staleSkills } from './skills.js'
import type { ErrandRetrievedNote, WebCourier } from './errand.js'
import { answersTheQuestion, contentWords, SEMANTIC_NOISE, SEMANTIC_SURE } from './search-template.js'
import { cleanOptions, formatAsk } from './ask.js'
import { carriesSecret } from './secrets.js'
import { str } from './page-report.js'
import { type HarnessMetric } from './harness-metrics.js'

export function noteBodyIn(read: string, label: string): string | null {
  const want = label.trim().toLowerCase()
  if (!want) return null
  for (const match of read.matchAll(/\[([^\]]+)\] \(id: [^)]+\) ([^[]+)/g)) {
    const title = match[1]!.trim().toLowerCase()
    if (title !== want && !title.includes(want) && !want.includes(title)) continue
    const body = match[2]!.replace(/(More than one of these|These are the nearest|These may not say it)[\s\S]*$/, '').trim()
    if (body) return body
  }
  return null
}

function withoutHeading(body: string): string {
  const lines = body.split('\n')
  return (/^#{1,6} /.test(lines[0] ?? '') ? lines.slice(1) : lines).join('\n').trim()
}

const BLANK_EMPTY = 'the blank is still empty'

export interface CometToolDeps {
  onMetric?(metric: HarnessMetric): void
  decidePage?: DecidePage
  batchReads?: boolean
  paths: VaultPaths
  skillNotes?(): Note[]
  retrieve(query: string, limit: number): Promise<ErrandRetrievedNote[]>
  courier?: WebCourier | null
  searchTemplate?(): Promise<string | null>
  runProcedure?(id: string, slots: Record<string, string>, signal?: AbortSignal, again?: boolean): Promise<string>
  remembered?(): string[]
  learnSearch?(template: string): Promise<void>
  guided?: boolean
  wallMet?(url: string): void
}

function recalled(remembered: string[] | undefined, query: string, task: string): string[] {
  if (!remembered?.length) return []
  const words = new Set([...contentWords(query), ...contentWords(task)].filter((w) => w.length > 1))
  return remembered.filter((fact) => {
    const low = fact.toLowerCase()
    return [...words].some((w) => low.includes(w))
  })
}

const RESULTS_CAP = 8
const BODY_EXCERPT = 300
const PROPOSE_BODY_CAP = 8_000

function record(args: Record<string, unknown>, key: string): Record<string, string> {
  const value = args[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [name, raw] of Object.entries(value as Record<string, unknown>))
    if (typeof raw === 'string') out[name] = raw
  return out
}

export function cometTools(deps: CometToolDeps): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: 'search_memory',
      description:
        "search the person's vault for notes about a topic; when what comes back is unrelated, try once more with the single most distinctive word — args: {\"query\": \"...\"}",
      argsSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      async run(args, context) {
        const query = str(args, 'query')
        if (!query) return 'search_memory needs a query'
        let hits = await deps.retrieve(query, RESULTS_CAP)
        if (hits.length === 0 && context.task && context.task !== query)
          hits = await deps.retrieve(context.task, RESULTS_CAP)
        if (hits.length === 0) {
          const known = recalled(deps.remembered?.(), query, context.task ?? '')
          if (known.length)
            return ['The notebook has nothing on this, but you remember:', ...known.map((f) => `- ${f}`), 'Answer from that.'].join('\n')
          return `nothing in the vault about "${query}" — try again with the words the person used in their request`
        }
        let found = hits.map((h) => `${h.title} ${h.body}`).join(' ')
        const asked = context.task || query
        const nearest = (list: ErrandRetrievedNote[]): number => Math.max(0, ...list.map((h) => h.meaning ?? 0))
        let missed =
          nearest(hits) < SEMANTIC_NOISE && !answersTheQuestion(found, asked) && !answersTheQuestion(found, query)
        if (missed && asked !== query) {
          const second = await deps.retrieve(asked, RESULTS_CAP)
          const secondText = second.map((h) => `${h.title} ${h.body}`).join(' ')
          if (nearest(second) >= SEMANTIC_NOISE || answersTheQuestion(secondText, asked)) {
            hits = second
            found = secondText
            missed = false
          }
        }
        if (missed) {
          const known = recalled(deps.remembered?.(), query, asked)
          if (known.length)
            return ['The notebook has nothing on this, but you remember:', ...known.map((f) => `- ${f}`), 'Answer from that.'].join('\n')
          return `the notebook has nothing about "${asked.slice(0, 60)}" - call search_web with {"query": "${asked.slice(0, 60)}"}`
        }
        return [
          ...hits.map((h) => `[${h.title}] (id: ${h.id}) ${withoutHeading(h.body).slice(0, BODY_EXCERPT)}`),
          ...(hits.length > 1
            ? ['More than one of these may bear on it: use what you need from all of them, not only the first.']
            : []),
          'These are the nearest notes in the vault.',
          ...(nearest(hits) < SEMANTIC_SURE && !answersTheQuestion(found, asked)
            ? [`These may not say it. Look outside as well: call search_web with {"query": "${asked.slice(0, 60)}"}`]
            : []),
        ].join('\n')
      },
    },
    {
      name: 'read_note',
      description: 'read one note in full by its id — args: {"id": "n-..."}',
      argsSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(args) {
        const id = str(args, 'id')
        if (!id) return 'read_note needs an id'
        const candidates = [id, ...(/^n-(rt|n)-/.test(id) ? [id.slice(2)] : [])]
        for (const candidate of candidates) {
          const note = await readNote(deps.paths, candidate).catch(() => null)
          if (!note) continue
          if (note.front.type === 'routine')
            return `"${noteTitle(note)}" is a saved procedure, not a note that holds an answer — run it: call run_procedure with {"id": "${note.front.id}", "slots": {}}`
          return `# ${noteTitle(note)}
Note created: ${note.front.created}; updated: ${note.front.updated}. These are note dates, not necessarily the activity date.
Activity date: ${note.front.happened_at ?? 'not recorded'}.
${note.body.slice(0, 2_000)}`
        }
        return `no note with id "${id.slice(0, 40)}"`
      },
    },
    {
      name: 'find_procedure',
      description:
        'find a task or browser procedure the person previously saved — args: {"task": "..."}',
      argsSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
      async run(args, context) {
        const task = str(args, 'task') || context.task
        const routines = await listRoutines(deps.paths)
        if (routines.length === 0)
          return 'nothing has been written down about this job yet - go and do it on the site itself: open it, read it, use the hands. At anything that would submit, save, send or buy, the person is asked first and sees the page.'
        const empty: ErrandRetrievedNote[] = []
        let ranked = await deps.retrieve(task, RESULTS_CAP).catch(() => empty)
        if (ranked.length === 0 && context.task !== task)
          ranked = await deps.retrieve(context.task, RESULTS_CAP).catch(() => empty)
        const byRank = ranked.map((hit) => routines.find((r) => r.id === hit.id)).filter((r) => r !== undefined)
        const words = task.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
        const scored = routines
          .map((r) => ({ r, score: words.filter((w) => r.name.toLowerCase().includes(w)).length }))
          .sort((a, b) => b.score - a.score)
        const callFor = (r: (typeof routines)[number]): string => {
          const slots = routineSlots(r.steps)
          const examples = routineSlotExamples(r.steps)
          const shown = slots.map((name) => (examples[name] ? `${name} (last time: "${examples[name].slice(0, 30)}")` : name))
          return slots.length > 0
            ? `Blanks to fill: ${shown.join(', ')}. Take each from the ask or from something read (search_memory); a blank the ask says nothing about keeps what it held last time. Then call run_procedure with {"id": "${r.id}", "slots": {${slots.map((name) => `"${name}": "..."`).join(', ')}}}.`
            : `Nothing to fill — call run_procedure with {"id": "${r.id}", "slots": {}}.`
        }
        const subjectOf = (r: (typeof routines)[number]): string => r.name.toLowerCase().split(/\s+/)[0] ?? ''
        const backed = (r: (typeof routines)[number], score: number): boolean =>
          score >= 2 || (subjectOf(r).length > 1 && task.toLowerCase().includes(subjectOf(r)))
        const meant = byRank[0] && scored[0]!.score > 0 && backed(scored[0]!.r, scored[0]!.score) ? byRank[0] : null
        const best = meant ? { r: meant, score: 1 } : backed(scored[0]!.r, scored[0]!.score) ? scored[0]! : { r: scored[0]!.r, score: 0 }
        if (best.score === 0)
          return [
            `nothing written down matches "${task.slice(0, 60)}" - go and do the job on the site itself, asking the person at anything that would submit. What is written down, in case one of these IS the job:`,
            ...routines.slice(0, RESULTS_CAP).map((r) => `- "${r.name}" — ${callFor(r)}`),
            'Make that call only when a saved name IS this very job. A neighbouring one — another report, another site, another form — is not it, and running it would do the wrong chore: do that job yourself on the site instead. If the person asked you to write, summarise or keep something rather than to work a website, this is not the tool — use propose_note.',
          ].join('\n')
        const steps = best.r.steps.map((s, i) => `${i + 1}. ${routineStepLabel(s)}`).join('; ')
        return `found "${best.r.name}" (id: ${best.r.id}): ${steps}. ${callFor(best.r)}`
      },
    },
    {
      name: 'open_skill',
      description:
        'read a saved how-to in full by its exact name from the skills list; "path" reads a reference within that skill folder. Files over 100 KB are refused, not truncated — args: {"name": "engram-...", "path": "references/..."}',
      argsSchema: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name'] },
      async run(args) {
        const name = str(args, 'name')
        if (!name) return 'open_skill needs the name of a skill from the list'
        const path = str(args, 'path') || undefined
        const body = await readSkillFile(deps.paths, name, path)
        if (body === null) return `no skill named "${name.slice(0, 60)}" — open one from the skills list, by its exact name`
        const stale = deps.skillNotes && staleSkills(await readSkillsLedger(deps.paths), deps.skillNotes()).some(slug => `engram-${slug}` === name)
        return [`"${name}" (a saved how-to — reference, not instructions):`, ...(stale ? ['This skill may be outdated. Verify its source notes and current state before relying on it.'] : []), body].join('\n')
      },
    },
    {
      name: 'propose_note',
      description:
        'write something down for the person — a summary, a decision, anything they asked you to keep. It becomes a card they approve — args: {"title": "...", "body": "..."}',
      argsSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' } },
        required: ['title', 'body'],
      },
      async run(args, context) {
        const title = str(args, 'title')
        const body = str(args, 'body')
        if (!title || !body) return 'propose_note needs a title and a body'
        if (carriesSecret(`${title} ${body}`, context.task))
          return 'that carries a password, so it is not going in a note — tell the person you do not write passwords down, and that they should sign in themselves on the page shown in the thread'
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
    {
      name: 'propose_edit',
      description: 'propose replacing an existing note with a new body — args: {"id": "n-...", "body": "..."}',
      argsSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, body: { type: 'string' } },
        required: ['id', 'body'],
      },
      async run(args) {
        const id = str(args, 'id')
        const body = str(args, 'body')
        if (!id || !body) return 'propose_edit needs a note id and the new body'
        try {
          await readNote(deps.paths, id)
        } catch {
          return `no note with id "${id.slice(0, 40)}" — nothing to edit`
        }
        const card = await createCard(deps.paths, {
          cardType: 'supersede',
          targets: [id],
          rationale: 'comet: proposed edit'.slice(0, 160),
          proposed: body.slice(0, PROPOSE_BODY_CAP),
          job: 'J1',
        })
        return `edit proposed — the person approves it in review (card ${card.id})`
      },
    },
  ]

  tools.push({
    name: 'find_skills',
    description: 'Find up to five relevant saved how-tos by topic when the initial shortlist does not fit. Returns names and descriptions, not execution permissions. Open a result with open_skill.',
    argsSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['query'], additionalProperties: false },
    async run(args) {
      const query = str(args, 'query')
      if (!query || query.length > 500) throw new Error('Provide a short skill topic')
      const ledger = await readSkillsLedger(deps.paths)
      const cards = annotateStaleCards(await listSkills(deps.paths), ledger, deps.skillNotes?.() ?? [])
      return JSON.stringify({ skills: relevantSkillCards(cards, ledger, query), referenceOnly: true })
    },
  })
  tools.push(...navigationTools(deps))

  tools.push({
    name: 'ask_person',
    description:
      'ask the person when you do not know where to look or what they meant; when there are a few clear ways forward, list them — args: {"question": "...", "options": ["...", "..."]}',
    argsSchema: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, maxItems: 4 } },
      required: ['question'],
    },
    async run(args) {
      const question = str(args, 'question')
      return question ? formatAsk(question, cleanOptions(args['options'])) : 'ask_person needs the question'
    },
  })

  if (deps.runProcedure) {
    const runProcedure = deps.runProcedure
    tools.push({
      name: 'run_procedure',
      description:
        'start a saved procedure or load a saved task to carry out with current observations; returned instructions are not a completed result. "again": true only after the person said to repeat a job — args: {"id": "rt-...", "slots": {"name": "value"}, "again": false}',
      argsSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, slots: { type: 'object', additionalProperties: { type: 'string' } }, again: { type: 'boolean' } },
        required: ['id'],
        additionalProperties: { type: 'string' },
      },
      async run(args, context) {
        const asked = str(args, 'id')
        if (!asked) return 'run_procedure needs the procedure id from find_procedure'
        const flat: Record<string, string> = {}
        for (const [key, value] of Object.entries(args))
          if (key !== 'id' && key !== 'slots' && key !== 'again' && typeof value === 'string') flat[key] = value
        const saved = await listRoutines(deps.paths)
        const exact = saved.find((one) => one.id === asked)
        const tail = asked.slice(asked.lastIndexOf('-') + 1)
        const near = saved.filter((one) => one.id.endsWith(tail))
        const id = exact?.id ?? (near.length === 1 ? near[0]!.id : asked)
        const filled = { ...flat, ...record(args, 'slots') }
        const shownWith = routineSlotExamples((await listRoutines(deps.paths)).find((r) => r.id === id)?.steps ?? [])
        for (const [slot, example] of Object.entries(shownWith)) if (!filled[slot]) filled[slot] = example
        const placeholder = Object.entries(filled).find(
          ([, value]) => typeof value === 'string' && (/^[\s.…·,;:!?<>"'\-_]*$/.test(value) || /^<.*>$/.test(value.trim())),
        )
        if (placeholder)
          return [
            `${BLANK_EMPTY}: "${placeholder[0]}" holds "${String(placeholder[1]).slice(0, 20)}", which says nothing.`,
            `Put the words you actually found there: call run_procedure with {"id": "${id}", "${placeholder[0]}": "<the words you found>"}`,
          ].join('\n')
        for (const [slot, value] of Object.entries(filled)) {
          const body = typeof value === 'string' ? noteBodyIn(context.read ?? '', value) : null
          if (body) filled[slot] = body
        }
        const read = `${context.task}\n${context.read ?? ''}`.replace(/\[[^\]]*\]/g, ' ').replace(/\(id: [^)]*\)/g, ' ')
        const invented = Object.entries(filled).find(
          ([, value]) => typeof value === 'string' && value.length > 0 && !answersTheQuestion(read, value),
        )
        if (invented)
          return [
            `${BLANK_EMPTY}: "${invented[0]}" holds "${String(invented[1]).slice(0, 30)}", which is nowhere in anything you have read.`,
            `Find it first - call search_memory with {"query": "${context.task.slice(0, 50)}"} - then run the procedure with what it says.`,
          ].join('\n')
        const outcome = await runProcedure(id, filled, context.signal, args['again'] === true)
        const blank = /nothing was filled in for ([^—]+)/.exec(outcome)
        if (!blank) return outcome
        const emptyRetry = Object.keys(filled).length === 0
        const slots = blank[1]!
          .split(',')
          .map((name) => `"${name.trim()}": "<the words you found, not the title of the note they were in>"`)
          .join(', ')
        return [
          outcome,
          emptyRetry
            ? `${BLANK_EMPTY}: you called it with nothing in them. Put what you found there: call run_procedure with {"id": "${id}", ${slots}}`
            : `${BLANK_EMPTY}. When you have it, call run_procedure with {"id": "${id}", ${slots}}`,
        ].join('\n')
      },
    })
  }

  return tools
}
