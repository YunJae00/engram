import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentTool, AgentToolContext } from './agent-loop.js'
import { renameWithRetry } from './rename-with-retry.js'
import type { SkillCandidate, SkillDraft } from './skills.js'
import { scriptLanguage } from './task-proposal.js'
import type { VaultPaths } from './vault.js'

// A job a comet could not do because it does not know the person's way of
// doing it is not guessed at: it offers to go and learn it - reading their
// past work where it shows, changing nothing - and comes back with a how-to
// for them to confirm before it does the job that way.

export interface Study {
  id: string
  botId: string
  what: string
  where: string[]
  // The job it is learning for, done again once the how-to is kept.
  ask: string
  state: 'offered' | 'studying' | 'review' | 'kept' | 'declined'
  at: string
  findings?: SkillDraft
}

const file = (paths: VaultPaths) => join(paths.cache, 'studies.json')
const KEEP = 40

// Keep the warm session's tool shape stable, but enforce study consent at execution.
const STUDY_READS = new Set([
  'search_memory', 'read_note', 'find_procedure', 'open_skill', 'find_skills',
  'open_page', 'search_web', 'read_open_page', 'read_pages', 'look', 'verify', 'wait_for',
  'app_read', 'app_text', 'read_desktop', 'look_desktop', 'list_windows', 'list_apps',
  'excel_workbooks', 'excel_read', 'outlook_mail', 'outlook_read', 'outlook_calendar',
  'file_read', 'file_read_workbook', 'desk_activity', 'ask_person', 'study_findings',
])

export function studyGuard(tool: AgentTool, active: () => boolean): AgentTool {
  const check = () => {
    if (active() && !STUDY_READS.has(tool.name)) throw new Error('Studying is read-only. Read available records; ask the person to open another view if needed. Changes and actions wait until the study is confirmed.')
  }
  return {
    ...tool,
    run: (args, context) => { check(); return tool.run(args, context) },
    ...(tool.runRich ? { runRich: (args: Record<string, unknown>, context: AgentToolContext) => { check(); return tool.runRich!(args, context) } } : {}),
  }
}

export async function readStudies(paths: VaultPaths): Promise<Study[]> {
  try {
    const raw = JSON.parse(await readFile(file(paths), 'utf8')) as unknown
    return Array.isArray(raw) ? raw.filter((one): one is Study => typeof one?.id === 'string' && typeof one?.botId === 'string') : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

let queue = Promise.resolve()
export function changeStudies(paths: VaultPaths, change: (studies: Study[]) => Study[]): Promise<Study[]> {
  const next = queue.then(async () => {
    const studies = change(await readStudies(paths)).slice(-KEEP)
    await mkdir(paths.cache, { recursive: true })
    await writeFile(`${file(paths)}.tmp`, JSON.stringify(studies, null, 2))
    await renameWithRetry(`${file(paths)}.tmp`, file(paths))
    return studies
  })
  queue = next.then(() => undefined, () => undefined)
  return next
}

export function studyCandidate(study: Study): SkillCandidate {
  return { slug: `study--${createHash('sha256').update(`${study.what}\n${study.ask}`).digest('hex').slice(0, 24)}`, folder: 'Learned by studying', notes: [], source: 'turn' }
}

// The turn that studies: what to learn, where it shows, and that nothing is changed.
export function studyMessage(study: Pick<Study, 'what' | 'where' | 'ask'>): string {
  const language = scriptLanguage(study.ask)
  return [
    `Study, without changing anything, how the person does this: "${study.what}" - so that the job "${study.ask}" can be done their way.`,
    `Look where their past work on it shows: ${study.where.length ? study.where.join(', ') : 'the apps and sites the job involves'}; their own records there (earlier entries, history, past messages and threads, sent replies), desk_activity for the apps they used around it, and the menus of the systems involved.`,
    'Read and move only. Never press anything that saves, sends, submits or deletes; those presses are refused while you study.',
    'Only reading tools are enabled during study. Read records through the available mail, file, app and page readers. Do not call action tools or commands; if another view needs a click or input, ask the person to open it instead.',
    'When you have looked, call study_findings with what you learned as a how-to, then tell the person in two or three sentences what you learned and that a card asks them to confirm it.',
    `Write to the person in ${language || 'the language of the job above'}.`,
  ].join('\n')
}

export function offerStudyTool(deps: { offer(input: { what: string; where: string[] }): Promise<void> }): AgentTool {
  return {
    name: 'offer_study',
    description: 'offer to learn how the person does a job you could not do because you do not know their way of doing it or where it lives in their systems - not because a page failed, timed out or needs a sign-in. A card asks them; if they agree you study their past work, reading only. Args: {"what": "what you do not know, in their words", "where": ["apps, sites or records where their past work on it would show"]}',
    argsSchema: { type: 'object', additionalProperties: false, required: ['what'], properties: { what: { type: 'string' }, where: { type: 'array', items: { type: 'string' } } } },
    async run(args) {
      const what = typeof args['what'] === 'string' ? args['what'].trim().slice(0, 300) : ''
      if (!what) throw new Error('what is what you do not know, in their words.')
      const where = Array.isArray(args['where']) ? (args['where'] as unknown[]).filter((one): one is string => typeof one === 'string' && !!one.trim()).map(one => one.trim().slice(0, 120)).slice(0, 8) : []
      await deps.offer({ what, where })
      return 'Offered: the person sees a card and decides. End your answer now, in one line, saying what you could not do.'
    },
  }
}

export function studyFindingsTool(deps: { found(draft: SkillDraft): Promise<boolean> }): AgentTool {
  return {
    name: 'study_findings',
    description: 'while studying, keep what you learned as a how-to for the person to confirm. Args: {"title": "short name of the job", "description": "one sentence: when it applies", "body": "markdown with three sections: when to use; the steps (where to go, what to read or fill, in their own terms and formats); open questions (what you could not find)"} - in the language of the conversation, the section headings included. The general way, not one case: no personal names, email addresses, dates of one case or one-time values - say "the recipient", "the latest deploy" instead.',
    argsSchema: { type: 'object', additionalProperties: false, required: ['title', 'description', 'body'], properties: { title: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' } } },
    async run(args) {
      const draft = { title: String(args['title'] ?? '').trim(), description: String(args['description'] ?? '').trim(), body: String(args['body'] ?? '').trim() }
      if (!draft.title || !draft.description || draft.body.length < 60) throw new Error('Give a title, a one-sentence description and a body with the three sections.')
      if (!await deps.found(draft)) return 'Nothing is being studied in this conversation; there is nothing to keep.'
      return 'Kept for the person to confirm. Now tell them in two or three sentences what you learned and that a card asks them to confirm it.'
    },
  }
}
