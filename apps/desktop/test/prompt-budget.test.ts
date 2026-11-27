import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { calendarLine, HAND_OFF_TOOL, memberPersona, promptFor, runComet, type AgentTool, type Engine, type NativeTools, type ToolSessionJob } from 'core'
import { answer, openWorld } from '../src/main/answer.js'
import { lookAsHelper } from '../src/main/helper-lanes.js'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>
const parent = fixture('prompts-parent.json') as Record<string, string>
const ceilings = fixture('prompt-budget.json') as Record<string, number>
const keep = fixture('prompt-keep.json') as Record<string, Record<string, number>>

const recorder = (jobs: ToolSessionJob[]): Engine => ({
  id: 'claude', desktopToolIsolation: true,
  detect: async () => ({ installed: true, loggedIn: true }),
  run: async function* () { yield { type: 'result', text: '' } },
  runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: '됐어요.' } },
}) as unknown as Engine
const tool = (name: string): AgentTool => ({ name, description: `does ${name}`, argsSchema: { type: 'object', properties: { q: { type: 'string' } } }, run: async () => '' })
const web = ['search_web', 'open_page', 'read_pages', 'search_memory', 'search_chats', 'keep_in_mind', 'schedule', 'offer_study'].map(tool)
const native: NativeTools = { cwd: '/vault/workspace/tasks/bot-1', readRoots: [], workspace: '/vault/workspace', mode: 'once', decide: async () => ({ behavior: 'allow' }) }
const toolText = (tools: readonly { name: string; description: string; argsSchema: object }[]) => tools.map(one => `${one.name}${one.description}${JSON.stringify(one.argsSchema)}`).join('')
const ruleText = (job: ToolSessionJob, task: string) => `${job.system}${job.prompt.replace(calendarLine(), '').replace(`Task: ${task}`, '')}`
const askOf = (key: string) => JSON.parse(parent[key]!.split('\n').pop()!.slice('Request: '.length)) as string

async function lead(task: string, tools: AgentTool[], options: Parameters<typeof runComet>[2]): Promise<ToolSessionJob> {
  const jobs: ToolSessionJob[] = []
  await runComet({ engine: recorder(jobs), workdir: { root: '/tmp/w' } as never, tools }, task, { guided: false, ...options })
  return jobs[0]!
}

const persona = memberPersona({ id: 'member-1', parentId: null, depth: 1, role: 'Haneul', brief: '서울 날씨 찾아줘', lookup: true, state: 'working', sessionKey: 'member-1', hiredAt: '2026-11-26T00:00:00.000Z' })
const scratch: string[] = []
const texts: Record<string, string> = {}
const held: Record<string, string> = {}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-26T09:00:00+09:00'))
  for (const [name, key, korean, said] of [['quick-ko', 'ack-ko', true, []], ['quick-en', 'ack-en', false, []], ['quick-ko-said', 'ack-ko-said', true, ['지금 시세 확인할게요.']]] as [string, string, boolean, string[]][]) {
    texts[name] = promptFor('quick', { message: askOf(key), korean, said }) + toolText([HAND_OFF_TOOL])
  }
  const dir = await mkdtemp(join(tmpdir(), 'prompt-budget-'))
  scratch.push(dir)
  const jobs: ToolSessionJob[] = []
  const task = '안녕하세요'
  await answer(await openWorld(dir, recorder(jobs)), task)
  texts['lead-runner'] = ruleText(jobs[0]!, task).replaceAll(dir, '/w')
  texts['lead-runner-tools'] = toolText(jobs[0]!.tools).replaceAll(dir, '/w')
  texts['lead-full'] = promptFor('work', { task: '', flags: { engineId: 'claude', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false, native } }).system
  texts['lead-bare'] = ruleText(await lead('안녕하세요', [], {}), '안녕하세요')
  texts['lead-lookup'] = ruleText(await lead('도쿄 날씨', web.slice(0, 3), { lookup: true }), '도쿄 날씨')
  texts['teammate'] = ruleText(await lead('서울 날씨 찾아줘', web.slice(0, 3), { role: 'deep', lookup: true, persona }), '서울 날씨 찾아줘')
  const helper: ToolSessionJob[] = []
  await lookAsHelper({ channel: 'bot-1', engine: recorder(helper), workdir: { root: '/tmp/w' } as never, guided: false, toolsFor: async () => web, onStep: () => {} }, '부산 날씨', 0)
  texts['helper'] = ruleText(helper[0]!, '부산 날씨')
  held['lead-turn'] = promptFor('work', { task: '', flags: { engineId: 'claude', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false }, context: { plan: true, firstLine: { pending: true } }, resume: 'step 1 done' }).prompt
  held['lead-lookup-desktop'] = (await lead('도쿄 날씨', [tool('search_web'), tool('open_app')], { lookup: true })).system
})
afterAll(async () => { vi.useRealTimers(); await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const over = (sizes: Record<string, number>) => Object.keys(ceilings).filter(name => !(sizes[name]! <= ceilings[name]!))

describe('prompt sizes cannot grow back', () => {
  it('every scenario is at or under its ceiling, and every scenario is measured', () => {
    expect(Object.keys(texts).sort()).toEqual(Object.keys(ceilings).sort())
    expect(over(Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, text.length])))).toEqual([])
  })

  it('the teammate is measured with its member persona, so a longer persona is over the ceiling', () => {
    expect(texts['teammate']).toContain(persona)
    expect(texts['lead-lookup']).not.toContain(persona)
    expect(texts['teammate']!.length).toBeGreaterThan(texts['lead-lookup']!.length)
  })

  it('one extra character in any scenario is over its ceiling', () => {
    for (const name of Object.keys(ceilings)) {
      const sizes = Object.fromEntries(Object.entries(texts).map(([one, text]) => [one, (one === name ? `${text}x` : text).length]))
      expect(over(sizes), name).toEqual(ceilings[name] === texts[name]!.length ? [name] : [])
    }
  })
})

describe('the sentences that must survive word for word', () => {
  const count = (text: string, sentence: string) => text.split(sentence).length - 1
  it.each(Object.keys(keep))('each sentence held for %s appears as often as the keep list says', name => {
    for (const [sentence, times] of Object.entries(keep[name]!)) expect(count({ ...texts, ...held }[name]!, sentence), sentence.slice(0, 80)).toBe(times)
  })

  it('a sentence that is missing or doubled is caught', () => {
    const [sentence] = Object.keys(keep['lead-runner']!)
    const text = texts['lead-runner']!
    expect(count(text, sentence!)).toBe(1)
    expect(count(text.replace(sentence!, ''), sentence!)).not.toBe(1)
    expect(count(`${text}${sentence}`, sentence!)).not.toBe(1)
  })
})
