import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runComet, sessionShape, type AgentTool, type Engine, type NativeTools, type PromptContext, type ToolSessionJob } from 'core'
import { answer, openWorld } from '../src/main/answer.js'
import { beginFirstLine, endFirstLine, firstLineReady } from '../src/main/first-line.js'
import { firstLineNote } from './ack-prompt.js'
import { ESCALATE_RULE, ESCALATE_TOOL } from '../../../packages/core/src/prompt.js'
import { lookAsHelper } from '../src/main/helper-lanes.js'

const parent = JSON.parse(readFileSync(new URL('fixtures/prompts-parent.json', import.meta.url), 'utf8')) as Record<string, unknown>
const scratch: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const tool = (name: string): AgentTool => ({ name, description: `does ${name}`, argsSchema: { type: 'object', properties: { q: { type: 'string' } } }, run: async () => '' })
const recorder = (id: string, jobs: ToolSessionJob[]): Engine => ({
  id, desktopToolIsolation: true,
  detect: async () => ({ installed: true, loggedIn: true }),
  run: async function* () { yield { type: 'result', text: '' } },
  runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: '됐어요.' } },
}) as unknown as Engine
const native = (more: Partial<NativeTools> = {}): NativeTools => ({ cwd: '/vault/workspace/tasks/bot-1', readRoots: [], decide: async () => ({ behavior: 'allow' }), ...more })
const history = [{ role: 'user' as const, text: '다음 주 목요일에 부모님이랑 제주도 가' }, { role: 'assistant' as const, text: '좋겠어요. 날씨 한번 볼게요.' }]
const shot = (job: ToolSessionJob) => ({ system: job.system, prompt: job.prompt, opening: job.opening ?? null })
const doubled = ' When the turn says a first line from you is already on screen, write nothing before your first tool call and nothing between tool calls: your next words are the answer. Only when no such line is up does one short, friendly sentence that you are on it come before the first tool call; after it, a word between steps is only a short note that a part is finished or that the route changed, never another greeting and never what you are about to read or check.'
const minusDoubled = (was: unknown): unknown => typeof was === 'string' ? was.replace(doubled, '') : was && typeof was === 'object' && 'system' in was ? { ...was, system: (was as { system: string }).system.replace(doubled, '') } : was

describe('one prompt builder: every role builds the same prompt the parent commit built for the same inputs', () => {
  it('work, deep and helper prompts and the turn notes are the parent snapshot less the doubled first-line sentence; the chat lead adds only the escalate rule, is no longer than the parent with the escalate tool counted, and starts after the quick tier chose, so no pending-line note is left', async () => {
  const out: Record<string, unknown> = {}
  const lead = async (name: string, engineId: string, tools: AgentTool[], task: string, options: Parameters<typeof runComet>[2]) => {
    const jobs: ToolSessionJob[] = []
    await runComet({ engine: recorder(engineId, jobs), workdir: { root: '/tmp/w' } as never, tools }, task, { guided: false, ...options })
    out[name] = shot(jobs[0]!)
  }
  const web = ['search_web', 'open_page', 'read_pages', 'search_memory', 'search_chats', 'keep_in_mind', 'schedule', 'offer_study'].map(tool)
  await lead('lead-web', 'claude', web, '엔비디아 오늘 주가 알려줘', { persona: 'You are 지민, a colleague who gets the task done.', memory: 'The person is 민호.', history, onScreen: 'screen text', context: { attachments: 'note one', turn: 'note two' }, resume: 'step 1 done', skills: [{ name: 'stock', description: 'reads a quote' }] })
  await lead('lead-bare', 'claude', [], '안녕하세요', {})
  await lead('lead-short', 'claude', web.slice(0, 2), '1년은 몇 초야?', { short: true, history })
  await lead('lead-lookup', 'claude', web.slice(0, 3), '도쿄 날씨', { lookup: true, persona: 'You are 서연.' })
  const desk = ['file_read', 'file_read_package', 'file_edit_package', 'file_move', 'file_create_workbook', 'app_read', 'open_app', 'page_do', 'page_steps', 'hire_members', 'open_page'].map(tool)
  await lead('lead-desk', 'claude', desk, 'fixtures 정리해줘', { native: native({ workspace: '/vault/workspace', mode: 'once' }), history })
  await lead('lead-codex', 'codex', desk.slice(0, 5), '보고서 고쳐줘', { native: native({ mode: 'each' }) })
  await lead('lead-plan', 'claude', desk.slice(0, 4), '계획만 세워줘', { native: native({ mode: 'plan', workspace: '/vault/workspace' }), short: true })
  await lead('teammate', 'claude', web.slice(0, 3), '서울 날씨 찾아줘', { role: 'deep', persona: 'You are 도윤, on the team. Bring back what you found.', lookup: true, session: 'member-1' })
  out['warm'] = sessionShape({ engine: { id: 'claude' } as Engine, tools: desk }, { native: native({ workspace: '/vault/workspace' }) }).system
  out['warm-bare'] = sessionShape({ engine: { id: 'codex' } as Engine, tools: web }).system

  const helperJobs: ToolSessionJob[] = []
  await lookAsHelper({ channel: 'bot-1', engine: recorder('claude', helperJobs), workdir: { root: '/tmp/w' } as never, guided: false, toolsFor: async () => web, onStep: () => {} }, '부산 날씨', 0)
  out['helper'] = shot(helperJobs[0]!)


  const quiet = new AbortController()
  let resolve: (line: string) => void = () => {}
  const engine = { id: 'claude', quick: () => new Promise<{ text: string; handOff: string }>(done => { resolve = line => done({ text: line, handOff: '날씨' }) }) } as unknown as Engine
  beginFirstLine({ channel: 'bot-a', message: '날씨 봐줘', korean: true, interactive: true, studying: false, limited: false, secret: false, engine: async () => engine, workdir: { root: '/tmp/w' } as never, signal: quiet.signal, show: () => {} })
  await new Promise(done => setTimeout(done, 20))
  out['note-pending'] = firstLineNote('bot-a')
  firstLineReady('bot-a')
  resolve('날씨 확인할게요.')
  await new Promise(done => setTimeout(done, 20))
  out['note-shown'] = firstLineNote('bot-a')
  endFirstLine('bot-a')
  out['note-none'] = firstLineNote('bot-a')

  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-26T09:00:00+09:00'))
  const pieces = { company: 'company note', handedBack: '지민: 서울 맑음', attachments: 'attached a.md', recovery: 'recovery note', turn: 'turn note', team: 'team note', outputs: 'outputs note' }
  for (const [name, context] of [['context-full', { ...pieces, plan: true }], ['context-some', { handedBack: '서연: 부산 흐림', team: 'team note' }], ['context-none', {}]] as [string, PromptContext][]) {
    const jobs: ToolSessionJob[] = []
    const dir = await mkdtemp(join(tmpdir(), 'prompt-builder-'))
    scratch.push(dir)
    const world = await openWorld(dir, recorder('mock', jobs))
    await answer(world, '날씨 정리해줘', { tools: web.slice(0, 2), context: () => context })
    const job = shot(jobs[0]!)
    expect(job.system, name).toContain(ESCALATE_RULE)
    expect(job.system.length + ESCALATE_TOOL.description.length, name).toBeLessThanOrEqual((parent[name] as { system: string }).system.length)
    out[name] = { ...job, system: job.system.replace(`${ESCALATE_RULE}\n`, '') }
  }
  const kept = Object.keys(parent).filter(key => !key.startsWith('ack-'))
  expect(Object.keys(out)).toEqual(kept)
  const raced = `\n\n${parent['note-pending'] as string}`
  for (const key of kept) {
    const was = minusDoubled(parent[key]) as { prompt?: string }
    expect(out[key], key).toEqual(key.startsWith('context-') ? { ...was, prompt: was.prompt!.replace(raced, '') } : was)
  }
  })

  it('the moved prompt sentences live only in core/prompt.ts: no other source file defines or repeats one', () => {
    const root = new URL('../../../', import.meta.url)
    const home = new URL('packages/core/src/prompt.ts', root).pathname
    const sources = ['packages/core/src', 'apps/desktop/src'].flatMap(dir => readdirSync(new URL(dir, root), { recursive: true, encoding: 'utf8' }).filter(name => /\.tsx?$/.test(name)).map(name => new URL(`${dir}/${name}`, root).pathname)).filter(path => path !== home)
    const sentences = [...readFileSync(home, 'utf8').matchAll(/'((?:[^'\\\n]|\\.){60,})'|`([^`$]{60,})/g)].map(match => (match[1] ?? match[2])!)
    expect(sentences.length).toBeGreaterThan(60)
    const names = /\b(?:const|function)\s+(VOICE_RULE|NO_SELF_RESEARCH_RULE|FALLBACK_LADDER_RULE|RESULT_FIRST_RULE|TEAM_LEAD_RULE|ONE_BUBBLE_RULE|COLLEAGUE_CORE_RULE|CHOICE_RULE|FILE_JOB_RULE|COLLEAGUE_RULE|PRIOR_CLAIM_RULE|PLAIN_WORK_RULE|DESKTOP_TASK_RULE|DESKTOP_GATE_RULE|REFERENCE_ID_RULE|PLAN_RULE|EARLIER_REPLIES_RULE|WORK_REPLY_RULE|REPLIES_RULE|COMMAND_STEP_RULE|OFFICE_FILE_RULE|TEXTING_RULE|PAGE_DELTA_RULE|HELPER_PERSONA|HANDED_BACK|sessionRules|openRuleLines|personaLines|openSystemLines|conversationLines|resumeLines|skillIndexLines|firstLinePrompt|firstLineNote)\b/
    for (const path of sources) {
      const text = readFileSync(path, 'utf8')
      expect(text, path).not.toMatch(names)
      for (const sentence of sentences) expect(text.includes(sentence), `${path}: ${sentence}`).toBe(false)
    }
  })
})
