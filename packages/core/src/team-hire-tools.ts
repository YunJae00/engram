import type { AgentTool } from './agent-loop.js'
import { logTask, MEMBER_RESULT_CHARS, TEAM_MAX_DEPTH, TEAM_MAX_HIRES, type DelegatedTask, type TaskTeam, type TeamMember } from './delegated-tasks.js'

// The hidden team: the lead hires members for the parts of a job, a member may hire its own helpers.
// Rules and text live here; pool slots, sessions and abort live in the desktop team-runner.

export const TEAM_TOKEN_RESERVE = 45_000
export const HIRE_MAX_PER_CALL = 4
export const TEAM_PLAN_OK = ['이대로 진행', 'Go ahead as planned']
export const TEAM_PLAN_FIX = ['고칠 점 말할게', 'I want changes']
export const TEAM_PLAN_YES = /^\s*(이대로 진행(해|해줘|해주세요)?|go ahead as planned|go ahead|응|네|예|좋아|좋아요|진행해|진행해줘|yes|ok|okay)\s*[.!~]*\s*$/i
const CODING = /코딩|코드|개발|프로그램|앱\s*(을|를)?\s*만들|웹\s*사이트|\b(cod(e|ing)|develop\w*|implement\w*|program\w*|app|website|software|repo(sitory)?)\b/i
export const MEMBER_RULE = 'Do only your part. You may hire helpers only if your part clearly has separable pieces; review what they return before you report. Report the result in at most 2000 characters, then the files you made by path. You do not talk to the person: when only they can answer, call ask_person once and stop.'
export const MEMBER_BLOCKED = /^(new_bot|schedule|keep_in_mind|keep_how_to|offer_study|study_findings|report_result_check)$/
export const SCREEN_TOOL = /^(app_|desktop_|open_app|look_desktop|read_desktop|list_windows|excel_|word_|ppt_|outlook_|compose_live_document|edit_live_document|read_live_document)/
const TOKEN_REFUSAL = 'The task token budget is nearly used. Do not hire. Finish with what exists and close with what is done, what is missing and what comes next.'
const PLAN_FIRST = `Big team plan: nothing was hired. Show the plan to the person once before hiring: call ask_person with the members and what each delivers, options ["${TEAM_PLAN_OK[0]}", "${TEAM_PLAN_FIX[0]}"] in their language, and end this turn there. Hire after they agree in their next message. Their OK covers the plan only: sends, posts, purchases and deletions are still asked one by one.`
const REVIEW_NOTE = 'Review each member with review_member before you report. A member with "ask" needs the person: put exactly that line to them with ask_person, then pass the answer with review_member({id, ok:false, note:<answer>}).'

export interface MemberOutcome { answer: string; asked?: boolean; budgetExhausted?: boolean; error?: string }
export interface MemberRedo { note: string; answered?: boolean }

export interface TeamHost {
  // The caller's member id; null for the lead.
  self: string | null
  load(): Promise<DelegatedTask | undefined>
  // One atomic task write; returns work's value, undefined when there is no running task.
  change<T>(work: (task: DelegatedTask) => T): Promise<T | undefined>
  // Runs these members to an end state and persists it.
  run(ids: string[], signal?: AbortSignal, redo?: MemberRedo): Promise<void>
  // Closes sessions, state -> released.
  release(ids: string[]): Promise<void>
  live(id: string): boolean
  tokensLeft(): Promise<number>
  // The message that started the lead's current turn.
  personSaid(): string
}

const newTeam = (): TaskTeam => ({ members: [], hires: 0, maxHires: TEAM_MAX_HIRES, maxDepth: TEAM_MAX_DEPTH, big: false })
const cut = (text: string, max: number) => text.length > max ? text.slice(0, max) : text
const DOC_FILE = /(?:^|[\s("'`])((?:[~.]?\/|[A-Za-z]:\\)?[^\s"'`()<>]+\.(?:pdf|docx?|xlsx?|pptx?|csv|md|txt|html?|json|png|jpe?g|zip))(?=$|[\s)"'`.,])/gi

// A coding job, many members, or the caller saying so: the person sees the plan before anyone is hired.
export function bigPlan(goal: string, members: readonly { role: string; brief: string }[], flagged: boolean): boolean {
  return flagged || members.length > 3 || CODING.test([goal, ...members.flatMap(m => [m.role, m.brief])].join('\n'))
}

export const unreviewed = (team: TaskTeam | undefined, parentId: string | null): TeamMember[] => (team?.members ?? []).filter(m => m.parentId === parentId && m.state !== 'released')
// A task with a team is done only after its result check passed.
export const teamUnverified = (task: DelegatedTask): boolean => (task.team?.members.length ?? 0) > 0 && task.verified !== true
// Every member must have been reviewed (and so released) by its parent before the task is done.
export function teamReviewIssue(task: DelegatedTask): string {
  const open = (task.team?.members ?? []).filter(m => m.state !== 'released')
  return open.length ? `Team members not reviewed yet: ${open.map(m => `${m.role} (${m.id})`).join(', ')}. Call review_member for each before reporting done.` : ''
}

export function failOnRestart(team: TaskTeam, at: string, why = 'the app restarted while this member was working.'): string[] {
  const lost = team.members.filter(m => ['hired', 'working', 'waiting', 'reviewing'].includes(m.state))
  for (const m of lost) { m.state = 'failed'; m.result = `Failed: ${why}`; m.finishedAt = at }
  return lost.map(m => m.id)
}

export function releaseAll(team: TaskTeam, at: string): string[] {
  const open = team.members.filter(m => m.state !== 'released')
  for (const m of open) { m.state = 'released'; m.finishedAt ??= at }
  return open.map(m => m.sessionKey)
}

export function settleMember(member: TeamMember, outcome: MemberOutcome, at: string): void {
  const answer = outcome.answer.trim()
  member.finishedAt = at
  if (outcome.error || !answer) { member.state = 'failed'; member.result = cut(`Failed: ${outcome.error ?? 'it ended without an answer.'}`, MEMBER_RESULT_CHARS); return }
  member.state = outcome.asked ? 'waiting' : 'done'
  const tail = outcome.budgetExhausted ? '\n(stopped at the token budget)' : ''
  member.result = cut(answer, MEMBER_RESULT_CHARS - tail.length) + tail
  const files = [...[...answer.matchAll(/\[([^\]]+)\]\(engram-artifact:[^)\s]+\)/g)].map(m => m[1]!), ...[...answer.matchAll(DOC_FILE)].map(m => m[1]!)]
  if (files.length) member.files = [...new Set(files)].slice(0, 10)
}

export const memberPersona = (member: TeamMember): string => `You are "${member.role}", a member of a hidden team working for one person through a lead. ${MEMBER_RULE}`

// Complete on its own, so a session trimmed while idle loses nothing.
export function memberTask(member: TeamMember, goal: string, redo?: MemberRedo): string {
  return [
    'Your part:', member.brief,
    ...(member.deliverable ? ['', 'Deliver:', member.deliverable] : []),
    ...(redo ? ['', 'Your previous result:', member.result ?? '(none)', '', redo.answered ? 'The person answered your question:' : 'Your lead reviewed this and asks for a redo:', redo.note] : []),
    '', 'The overall job (context only; do only your part):', goal.slice(0, 400),
  ].join('\n')
}

export function teamTree(team: TaskTeam | undefined): string {
  if (!team?.members.length) return 'No team on this task.'
  const lines: string[] = []
  const walk = (parentId: string | null) => {
    for (const m of team.members.filter(one => one.parentId === parentId)) {
      lines.push(`${'  '.repeat(m.depth - 1)}- ${m.role} (${m.id}) [${m.state}]${m.result ? ` — ${m.result.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`)
      walk(m.id)
    }
  }
  walk(null)
  return [...lines, `hires ${team.hires}/${team.maxHires}`].join('\n')
}

export function teamNote(team: TaskTeam | undefined): string {
  if (!team?.members.length) return ''
  return ['The hidden team on this task:', teamTree(team), ...(team.members.some(m => m.state === 'failed') ? ['Members marked failed were lost; re-hire them with hire_members or finish with what exists.'] : [])].join('\n')
}

const view = (m: TeamMember) => ({ id: m.id, role: m.role, state: m.state, result: m.result ?? '', files: m.files ?? [], ...(m.state === 'waiting' ? { ask: `${m.role}: ${m.result ?? ''}` } : {}) })
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max + 1) : ''

export function teamHireTools(host: TeamHost): AgentTool[] {
  const hire: AgentTool = {
    name: 'hire_members',
    description: `Hire 1 to ${HIRE_MAX_PER_CALL} hidden team members for separable parts of this job and wait for their results. Each gets role (short name), brief (its whole part, complete on its own) and deliverable (what it hands back). notes carries what you already know that they need. Never hire for a one-step ask. Returns each member's result, files and state; review each with review_member.`,
    argsSchema: {
      type: 'object', additionalProperties: false, required: ['members'],
      properties: {
        members: { type: 'array', minItems: 1, maxItems: HIRE_MAX_PER_CALL, items: { type: 'object', additionalProperties: false, required: ['role', 'brief'], properties: { role: { type: 'string' }, brief: { type: 'string' }, deliverable: { type: 'string' } } } },
        notes: { type: 'string' }, big: { type: 'boolean' },
      },
    },
    async run(args, context) {
      const asked = (Array.isArray(args['members']) ? args['members'] : []) as Record<string, unknown>[]
      const wanted = asked.map(m => ({ role: text(m?.['role'], 40), brief: text(m?.['brief'], 1500), deliverable: text(m?.['deliverable'], 300) }))
      if (!wanted.length || wanted.length > HIRE_MAX_PER_CALL) throw new Error(`members needs 1 to ${HIRE_MAX_PER_CALL} entries, each with role, brief and deliverable.`)
      if (wanted.some(m => !m.role || m.role.length > 40 || !m.brief || m.brief.length > 1500 || m.deliverable.length > 300)) throw new Error('Each member needs role (1 to 40 characters), brief (1 to 1500) and deliverable (at most 300).')
      const notes = text(args['notes'], 1500).slice(0, 1500)
      if ((await host.tokensLeft()) < TEAM_TOKEN_RESERVE) return TOKEN_REFUSAL
      const n = wanted.length
      const out = await host.change((task): { refuse: string } | { ids: string[] } => {
        if (task.state !== 'running') return { refuse: 'No running task: nothing was hired.' }
        const team = task.team ?? newTeam()
        const parent = host.self === null ? undefined : team.members.find(m => m.id === host.self)
        if (host.self !== null && (!parent || parent.state === 'released')) return { refuse: 'You are no longer on this team: nothing was hired.' }
        const depth = (parent?.depth ?? 0) + 1
        if (depth > team.maxDepth) return { refuse: `Depth limit: a depth-${team.maxDepth} member cannot hire. Do this part yourself.` }
        const left = team.maxHires - team.hires
        if (n > left) return { refuse: `Hire budget: ${team.hires} of ${team.maxHires} used, ${left} left. Hire at most ${left} or do the work yourself.` }
        if (host.self === null && !team.approvedAt && (team.big || bigPlan(task.goal, wanted, args['big'] === true))) {
          task.team = team
          // Only a reply in a later turn than the one that was told to show the plan can approve it.
          if (team.planTurn !== undefined && task.turns > team.planTurn && TEAM_PLAN_YES.test(host.personSaid())) { team.approvedAt = new Date().toISOString(); logTask(task, 'Team plan approved') }
          else { team.big = true; team.planTurn = task.turns; return { refuse: PLAN_FIRST } }
        }
        task.team = team
        const at = new Date().toISOString()
        const ids = wanted.map(m => {
          const id = `m${team.members.length + 1}`
          team.members.push({ id, parentId: host.self, depth, role: m.role, brief: notes ? `${m.brief}\n\nNotes from ${parent?.role ?? 'the lead'}:\n${notes}` : m.brief, ...(m.deliverable ? { deliverable: m.deliverable } : {}), state: 'hired', sessionKey: `team-${task.id}-${id}`, hiredAt: at })
          return id
        })
        team.hires += n
        logTask(task, `Hired ${wanted.map(m => m.role).join(', ')}`)
        return { ids }
      })
      if (!out) return 'No running task: nothing was hired.'
      if ('refuse' in out) return out.refuse
      await host.run(out.ids, context.signal)
      const team = (await host.load())?.team
      return JSON.stringify({ members: (team?.members ?? []).filter(m => out.ids.includes(m.id)).map(view), hiresLeft: team ? team.maxHires - team.hires : 0, note: REVIEW_NOTE })
    },
  }
  const review: AgentTool = {
    name: 'review_member',
    description: 'Record your review of a member you hired, after reading its result. ok true accepts it and releases the member. ok false with a note re-runs it once with that note (counts as a hire), or passes the person\'s answer to a member that asked a question.',
    argsSchema: { type: 'object', additionalProperties: false, required: ['id', 'ok', 'note'], properties: { id: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string' } } },
    async run(args, context) {
      const id = String(args['id'] ?? ''), ok = args['ok'] === true, note = text(args['note'], 1500).slice(0, 1500)
      if (!ok && !note) throw new Error('note says what to redo, or carries the person\'s answer.')
      const busy = host.live(id)
      const plan = await host.change((task): { refuse: string } | { act: 'accept' | 'spent' | 'redo' | 'answer'; role: string } => {
        const team = task.team, member = team?.members.find(m => m.id === id && m.parentId === host.self)
        if (!team || !member) return { refuse: `No member "${id}" hired by you.` }
        if (busy || !['done', 'failed', 'waiting'].includes(member.state)) return { refuse: `${member.role} is ${busy ? 'working' : member.state}; it can be reviewed once it has reported.` }
        if (ok) { member.review = { ok: true, note }; return { act: 'accept', role: member.role } }
        const answer = member.state === 'waiting'
        if ((!answer && member.review?.ok === false) || team.hires + 1 > team.maxHires) { member.review = { ok: false, note }; return { act: 'spent', role: member.role } }
        if (!answer) member.review = { ok: false, note }
        team.hires++; member.state = 'hired'; delete member.finishedAt
        return { act: answer ? 'answer' : 'redo', role: member.role }
      })
      if (!plan) return 'No running task.'
      if ('refuse' in plan) return plan.refuse
      const spent = `${plan.role} was already redone once (or the hire/token budget is used). Released with its last result; use it or do the rest yourself.`
      if (plan.act === 'accept') { await host.release([id]); return JSON.stringify({ id, state: 'released' }) }
      if (plan.act === 'spent') { await host.release([id]); return spent }
      if ((await host.tokensLeft()) < TEAM_TOKEN_RESERVE) {
        await host.change(task => { const m = task.team?.members.find(one => one.id === id); if (m && task.team) { m.state = 'failed'; task.team.hires-- } })
        await host.release([id]); return spent
      }
      await host.run([id], context.signal, { note, answered: plan.act === 'answer' })
      const after = (await host.load())?.team?.members.find(m => m.id === id)
      if (!after) return 'No running task.'
      if (plan.act === 'answer' || after.state === 'waiting') return JSON.stringify(view(after))
      await host.release([id])
      return JSON.stringify({ ...view(after), state: 'released' })
    },
  }
  const status: AgentTool = {
    name: 'team_status',
    description: 'The hidden team on this task as a tree: each member, its state and the start of its result. Use it to answer "how is it going".',
    argsSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: async () => teamTree((await host.load())?.team),
  }
  return [hire, review, status]
}
