import type { MemberState, TeamMember } from 'core'
import { uiLanguage } from '../i18n.js'
import { teamT, type TeamLang } from '../i18n-team.js'
import { sidebarPreview } from './sidebarPreview.js'
import { displayTaskAnswer, threadLang } from './threadLang.js'
import { KO_CARRY_ON } from './threadLangKo.js'

export type TeamMemberView = Pick<TeamMember, 'id' | 'parentId' | 'role' | 'state' | 'result'>
export interface TeamView { taskId: string; members: TeamMemberView[] }
export interface TeamNode { member: TeamMemberView; children: TeamNode[] }
export type TeamChip = 'working' | 'reviewing' | 'done' | 'failedChip' | 'released'

const CHIPS: Record<MemberState, TeamChip> = { hired: 'working', working: 'working', waiting: 'working', reviewing: 'reviewing', done: 'done', failed: 'failedChip', released: 'released' }
const LIVE_TASK = ['queued', 'running', 'waiting']
const ACTIVE: MemberState[] = ['hired', 'working', 'waiting', 'reviewing']

type Loose = Record<string, unknown>
const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null

function memberView(raw: unknown): TeamMemberView | null {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.role !== 'string' || typeof raw.state !== 'string' || !Object.hasOwn(CHIPS, raw.state)) return null
  return { id: raw.id, parentId: typeof raw.parentId === 'string' ? raw.parentId : null, role: raw.role, state: raw.state as MemberState, result: typeof raw.result === 'string' ? raw.result : undefined }
}

// A message that only says to carry on: that task picks up the work of the task before it, team included.
// shortcut: reads the message against a short list of carry-on words, since a task keeps no link to the one it continues; upgrade when a task records what it continues.
const CARRY_ON = /^(?:please\s+)?(?:continue|go on|keep going|carry on|resume|proceed)(?:\s+please)?$/i
const carriesOn = (goal: unknown): boolean => { const words = typeof goal === 'string' ? goal.trim().replace(/[\s.!~…"'“”]+$/u, '') : ''; return CARRY_ON.test(words) || KO_CARRY_ON.test(words) }

// tasks:list passes each task's team through untyped, so every field is checked here.
// A bot shows the team of its latest task that hired one, also after that task ended (done, stopped, or stopped at a limit) and through a
// plain "continue" that followed it: the leads and how they finished stay on view. Any other later task is work of its own: one that
// hires a team shows that team, and one without a team shows none (qa143 S19c: an unrelated task showed the old released team).
// Once the task is over nobody is working: a member it left mid-work shows as released.
export function activeTeams(tasks: unknown): Map<string, TeamView> {
  const teams = new Map<string, TeamView>()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isObject(task) || typeof task.botId !== 'string') continue
    const live = LIVE_TASK.includes(String(task.state))
    const members = (isObject(task.team) && Array.isArray(task.team.members) ? task.team.members : []).map(memberView).filter(member => member !== null).map(member => live || !ACTIVE.includes(member.state) ? member : { ...member, state: 'released' as const })
    if (members.length) teams.set(task.botId, { taskId: String(task.id), members })
    else if (!carriesOn(task.goal)) teams.delete(task.botId)
  }
  return teams
}

export function teamCounts(members: TeamMemberView[]): { total: number; active: number; failed: number } {
  return { total: members.length, active: members.filter(member => ACTIVE.includes(member.state)).length, failed: members.filter(member => member.state === 'failed').length }
}

// grokbar c4 R1/R2/H5: the finished summary (summaryIdle) stayed under a delivered answer and read as a status report. The strip in the thread is there
// only while someone is working (GROKBOT rule 8), and since c5 so is the line under the sidebar row.
export const teamWorking = (members: TeamMemberView[]): boolean => teamCounts(members).active > 0

export function teamSummaryText(members: TeamMemberView[], lang: TeamLang): string {
  const { total, active, failed } = teamCounts(members)
  const summary = active ? teamT(lang, 'summaryWorking', { n: total, m: active }) : teamT(lang, 'summaryIdle', { n: total })
  return failed ? `${summary} · ${teamT(lang, 'failed', { f: failed })}` : summary
}

export function teamForest(members: TeamMemberView[]): TeamNode[] {
  const ids = new Set(members.map(member => member.id))
  const seen = new Set<string>()
  const node = (member: TeamMemberView): TeamNode => {
    seen.add(member.id)
    return { member, children: members.filter(child => child.parentId === member.id && !seen.has(child.id)).map(node) }
  }
  const roots = members.filter(member => member.parentId === null || !ids.has(member.parentId) || member.parentId === member.id).map(node)
  // Members left over sit in a parent cycle; each still shows once.
  for (const member of members) if (!seen.has(member.id)) roots.push(node(member))
  return roots
}

export const memberChip = (state: MemberState): TeamChip => CHIPS[state]

// A waiting member's result is its question and a failure note is system English, so neither is shown.
export function memberResult(member: TeamMemberView): string {
  if (member.state !== 'done' && member.state !== 'released') return ''
  const result = member.result?.trim() ?? ''
  return result && !result.startsWith('Failed: ') ? sidebarPreview(result.split(/\n\s*\n/)[0]!) : ''
}

// The sidebar's line for a last message. Before the thread is opened after a relaunch it has no messages, so the saved last message tells the language (qa145 S30).
export const lastPreview = (text: string, messages: { role: string; text: string }[], lastMessage?: { role: string; text: string }): string => sidebarPreview(displayTaskAnswer(text, lineLang(messages, lastMessage)))

export function lineLang(messages: { role: string; text: string }[], lastMessage?: { role: string; text: string }): TeamLang {
  return messages.length ? threadLang(messages) : lastMessage ? threadLang([lastMessage]) : uiLanguage()
}
