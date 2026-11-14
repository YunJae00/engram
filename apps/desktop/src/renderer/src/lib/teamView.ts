import type { MemberState, TeamMember } from 'core'
import { uiLanguage } from '../i18n.js'
import { teamT, type TeamLang } from '../i18n-team.js'
import { sidebarPreview } from './sidebarPreview.js'
import { threadLang } from './threadLang.js'

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

// tasks:list passes each task's team through untyped, so every field is checked here.
export function activeTeams(tasks: unknown): Map<string, TeamView> {
  const latest = new Map<string, Loose>()
  for (const task of Array.isArray(tasks) ? tasks : []) if (isObject(task) && typeof task.botId === 'string') latest.set(task.botId, task)
  const teams = new Map<string, TeamView>()
  for (const [botId, task] of latest) {
    if (!LIVE_TASK.includes(String(task.state)) || !isObject(task.team) || !Array.isArray(task.team.members)) continue
    const members = task.team.members.map(memberView).filter(member => member !== null)
    if (members.length) teams.set(botId, { taskId: String(task.id), members })
  }
  return teams
}

export function teamCounts(members: TeamMemberView[]): { total: number; active: number; failed: number } {
  return { total: members.length, active: members.filter(member => ACTIVE.includes(member.state)).length, failed: members.filter(member => member.state === 'failed').length }
}

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

export function lineLang(messages: { role: string; text: string }[], lastMessage?: { role: string; text: string }): TeamLang {
  return messages.length ? threadLang(messages) : lastMessage ? threadLang([lastMessage]) : uiLanguage()
}
