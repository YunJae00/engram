import { appendBotTurn, readBotTranscript, withoutSecrets, type DelegatedTask, type TaskTeam, type TurnStep, type VaultPaths } from 'core'
import type { EngramEvent } from '../shared/types.js'
import { flog } from './flog.js'

export type ClosingReason = 'budget' | 'turn-limit' | 'error' | 'empty' | 'restart'
export type ClosingLang = 'en' | 'ko'
type Turn = { role: string; text: string; at?: string; progress?: boolean }
export interface ClosingInput { goal: string; work?: number; trail?: readonly TurnStep[]; result?: string; transcript: readonly Turn[]; since?: string; detail?: string; log?: readonly { line: string }[]; team?: TaskTeam }

export const ENDED_LOG = 'The turn ended without an answer.'
const ENDED_KO = '답을 마치지 못하고 끝났어요.'
const LEGACY_RESTARTED = 'The app restarted during this task. Check any external changes before asking me to continue.'
export const isKorean = (text = ''): boolean => /[가-힣]/.test(text)

export function closingLang(transcript: readonly Turn[], goal: string): ClosingLang {
  const asked = [...transcript].reverse().find(turn => turn.role === 'user')?.text
  return isKorean(asked ?? goal) ? 'ko' : 'en'
}

const finishedMembers = (team: TaskTeam) => team.members.filter(m => m.state === 'done' || m.state === 'released' && !m.result?.startsWith('Failed:'))
const cut = (text: string, max: number) => { const line = (text.split('\n')[0] ?? '').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line }

const WORDS = {
  ko: {
    done: (parts: string[]) => parts.length ? `한 일: ${parts.join(', ')}.` : '한 일: 아직 확인된 결과는 없어요.',
    steps: (n: number) => `${n}단계 진행`,
    confirmed: (n: number) => `확정한 작업 ${n}개`,
    files: (names: string) => `저장한 파일 ${names}`,
    more: (n: number) => ` 외 ${n}개`,
    milestone: (line: string) => `마지막 진행: ${line}`,
    approved: (words: string) => `“${words}” 승인`,
    team: (done: number, total: number, missing: string) => `팀 ${total}명 중 ${done}명 완료${missing ? ` (남은 일: ${missing})` : ''}`,
    missing: {
      budget: (g: string) => `${g} 작업이 처리 한도에 닿아 끝나지 않았어요.`,
      'turn-limit': (g: string) => `${g} 작업이 진행 횟수 한도에 닿아 끝나지 않았어요.`,
      error: (g: string, d: string) => `${g} 작업이 오류로 중단됐어요${d ? ` (${d})` : ''}.`,
      empty: () => ENDED_KO,
      restart: (g: string) => `작업 중에 앱이 다시 시작돼서 ${g} 작업이 중간에 멈췄어요.`,
    },
    next: {
      budget: '다음: 남은 부분을 더 작게 나눠 다시 맡겨 주시면 위 결과부터 이어서 할게요.',
      'turn-limit': '다음: 남은 부분을 더 작게 나눠 다시 맡겨 주시면 위 결과부터 이어서 할게요.',
      error: '다음: 잠시 뒤 같은 요청을 다시 보내 주세요. 같은 오류가 반복되면 설정에서 AI 연결을 확인해 주세요.',
      empty: '다음: “이어서 해줘”라고 보내 주시면 지금 상태를 확인하고 이어갈게요.',
      restart: '다음: 그사이 바뀐 것이 있는지 확인한 뒤 답해 주시면 확인된 일은 반복하지 않고 이어서 할게요.',
    },
  },
  en: {
    done: (parts: string[]) => parts.length ? `Done so far: ${parts.join(', ')}.` : 'Done so far: nothing confirmed yet.',
    steps: (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`,
    confirmed: (n: number) => `${n} confirmed ${n === 1 ? 'action' : 'actions'}`,
    files: (names: string) => `saved ${names}`,
    more: (n: number) => ` and ${n} more`,
    milestone: (line: string) => `Last step: ${line}`,
    approved: (words: string) => `approved “${words}”`,
    team: (done: number, total: number, missing: string) => `${done} of ${total} team members finished${missing ? ` (not finished: ${missing})` : ''}`,
    missing: {
      budget: (g: string) => `${g} stopped at the task's processing limit before it was finished.`,
      'turn-limit': (g: string) => `${g} stopped at the task's turn limit before it was finished.`,
      error: (g: string, d: string) => `${g} stopped on an error${d ? ` (${d})` : ''}.`,
      empty: () => ENDED_LOG,
      restart: (g: string) => `The app restarted during this task, so ${g} stopped partway.`,
    },
    next: {
      budget: 'Next: send the remaining part as a smaller request and I will pick up from the results above.',
      'turn-limit': 'Next: send the remaining part as a smaller request and I will pick up from the results above.',
      error: 'Next: send the same request again in a moment. If the error repeats, check the AI connection in Settings.',
      empty: 'Next: say “continue” and I will check the current state and carry on.',
      restart: 'Next: check for any outside changes, then reply and I will continue without repeating confirmed steps.',
    },
  },
} as const

export function closingMessage(input: ClosingInput, reason: ClosingReason, lang: ClosingLang): string {
  const w = WORDS[lang]
  const recent = input.transcript.filter(turn => turn.role === 'assistant' && (!input.since || !turn.at || turn.at >= input.since))
  const names = [...new Set([input.result ?? '', ...recent.map(turn => turn.text)].flatMap(text => [...text.matchAll(/\[([^\]]+)\]\(engram-artifact:[^)\s]+\)/g)].map(m => m[1]!)))]
  const confirmed = (input.trail ?? []).filter(step => step.committed).length
  const parts = [
    ...(input.work ? [w.steps(input.work)] : []),
    ...(confirmed ? [w.confirmed(confirmed)] : []),
    ...(input.team?.members.length ? [w.team(finishedMembers(input.team).length, input.team.members.length, input.team.members.filter(m => !finishedMembers(input.team!).includes(m)).map(m => m.role).slice(0, 4).join(', '))] : []),
    ...(names.length ? [w.files(names.slice(0, 3).join(', ') + (names.length > 3 ? w.more(names.length - 3) : ''))] : []),
  ]
  const progress = [...recent].reverse().find(turn => turn.progress && turn.text.trim())
  const approved = (input.log ?? []).flatMap(entry => /^Approved: "(.+)"$/.exec(entry.line)?.[1] ?? []).slice(-3).map(words => w.approved(cut(words, 40)))
  const milestone = progress ? cut(progress.text, 100) : !names.length && approved.length ? approved.join(', ') : ''
  const goal = `“${cut(input.goal, 60)}”`
  const detail = input.detail ? cut(withoutSecrets(input.detail, input.goal), 160) : ''
  return [
    w.done(parts),
    ...(milestone ? [w.milestone(milestone)] : []),
    w.missing[reason](goal, detail),
    w.next[reason],
  ].join('\n')
}

export const isRestartQuestion = (question: string): boolean => question === LEGACY_RESTARTED || question.includes('앱이 다시 시작돼서') || question.includes('The app restarted during this task')

export async function restartQuestion(paths: VaultPaths, task: DelegatedTask): Promise<string> {
  const transcript = await readBotTranscript(paths, task.botId).catch(() => [])
  return closingMessage({ goal: task.goal, work: task.work, result: task.result, transcript, since: task.createdAt, log: task.log, team: task.team }, 'restart', closingLang(transcript, task.goal))
}

// Every end the person did not ask for leaves one closing message in the thread; a raw error goes out only when this end is not the task's own.
// The seat is reopened even for an empty turn: a provider error may already have settled the bubble, and carryOn keeps a still-open one as is.
export async function closeTask(paths: VaultPaths, broadcast: (event: EngramEvent) => void, end: { task?: DelegatedTask; reason: ClosingReason; channel?: string; trail?: readonly TurnStep[]; error?: unknown; goal?: string }): Promise<void> {
  const { task, reason, channel, trail, error, goal = '' } = end
  const raw = error === undefined ? undefined : error instanceof Error ? error.message : String(error)
  if (!channel) return
  const own = task?.state === 'failed' && (raw === undefined || task.log.at(-1)?.line.startsWith('Failed:'))
  if (!task) {
    if (raw === undefined) return
    // The request that just failed is the newest thing the person said; an older turn may be in another language.
    const transcript = channel.startsWith('bot-') ? await readBotTranscript(paths, channel.slice(4)).catch(() => []) : []
    broadcast({ type: 'chat:error', channel, message: closingMessage({ goal, transcript, since: new Date().toISOString(), detail: raw }, reason, closingLang(goal.trim() ? [] : transcript, goal)) })
    return
  }
  if (!own) { if (raw !== undefined) broadcast({ type: 'chat:error', channel, message: raw }); return }
  const transcript = await readBotTranscript(paths, task.botId).catch(() => [])
  const text = closingMessage({ goal: task.goal, work: task.work, trail, result: task.result, transcript, since: task.createdAt, detail: raw, log: task.log, team: task.team }, reason, closingLang(transcript, task.goal))
  try { await appendBotTurn(paths, task.botId, { role: 'assistant', text, at: new Date().toISOString() }) } catch (e) { flog('tasks', e) }
  if (raw !== undefined) broadcast({ type: 'chat:error', channel, message: text })
  else { broadcast({ type: 'comet:continue', channel, botId: task.botId }); broadcast({ type: 'chat:done', channel, text }) }
}

// A Stop under words already written stores its mark after them, once the stopped run is released and its words are flushed.
export async function keepStopMark(paths: VaultPaths, broadcast: (event: EngramEvent) => void, channel: unknown, text: unknown, running: () => boolean, waitMs = { run: 15_000, settle: 1_000 }): Promise<void> {
  if (typeof channel !== 'string' || !channel.startsWith('bot-') || typeof text !== 'string' || !text.trim() || text.length > 80) return
  const pause = () => new Promise(resolve => setTimeout(resolve, 50))
  try {
    for (const until = Date.now() + waitMs.run; running(); await pause()) if (Date.now() > until) return
    // An aborted run can end without chat:done; this flushes its pending words as the stored progress turn.
    broadcast({ type: 'chat:token', channel, text: '', reset: true })
    const botId = channel.slice(4)
    for (const until = Date.now() + waitMs.settle; Date.now() <= until; await pause()) {
      const last = (await readBotTranscript(paths, botId, 1))[0]
      if (last?.role !== 'assistant') continue
      if (!last.progress) return
      await appendBotTurn(paths, botId, { role: 'assistant', text: text.trim(), at: new Date().toISOString() })
      broadcast({ type: 'bots:changed' })
      return
    }
  } catch (error) { flog('tasks', error) }
}
