import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { calendarLine, HAND_OFF_TOOL, memberPersona, promptFor, runComet, type AgentTool, type Engine, type NativeTools, type ToolSessionJob } from 'core'
import { answer, openWorld } from '../src/main/answer.js'
import { lookAsHelper } from '../src/main/helper-lanes.js'
import { CHOICE_RULE, COLLEAGUE_CORE_RULE, COLLEAGUE_RULE, FILE_JOB_RULE, ONE_BUBBLE_RULE, PERSIST_RULE, PERSIST_WEB_RULE, PLAIN_WORK_RULE, PRIOR_CLAIM_RULE, REFERENCE_ID_RULE, REPLIES_RULE, TO_PERSON_RULE, VOICE_RULE, WORK_REPLY_RULE } from '../../../packages/core/src/prompt.js'
import { stepPrompt, wrapUpPrompt } from '../../../packages/core/src/agent-prompt.js'

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
const runnerTurn: { system: string; prompt: string } = { system: '', prompt: '' }

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
  Object.assign(runnerTurn, { system: jobs[0]!.system, prompt: jobs[0]!.prompt })
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

  it('the lead reads the reply-chips rule and the one-bubble rule once across its system and turn prompt', () => {
    for (const rule of [REPLIES_RULE, ONE_BUBBLE_RULE]) expect(count(texts['lead-runner']!, rule), rule.slice(0, 40)).toBe(1)
  })

  it('the reply-chips rule is one short rule in the system only, opening with the parent\'s first sentence word for word', async () => {
    const opening = 'Then always close with a fenced block whose language is replies'
    const was = parent['lead-web'] as unknown as { system: string }
    const firstOf = (text: string) => text.slice(text.indexOf(opening), text.indexOf('the app shows them as buttons.', text.indexOf(opening)) + 'the app shows them as buttons.'.length)
    expect(firstOf(REPLIES_RULE)).toBe(firstOf(was.system))
    expect(REPLIES_RULE.startsWith(firstOf(was.system))).toBe(true)
    expect(REPLIES_RULE.length).toBeLessThanOrEqual(1300)
    expect(count(runnerTurn.system, REPLIES_RULE)).toBe(1)
    expect(count(runnerTurn.prompt, opening)).toBe(0)
    const dir = await mkdtemp(join(tmpdir(), 'prompt-budget-'))
    scratch.push(dir)
    const jobs: ToolSessionJob[] = []
    await answer(await openWorld(dir, recorder(jobs)), '동창회 공지 초안 하나 써줘. 단톡방에 올리는 건 내가 말할 때')
    expect(count(jobs[0]!.system, REPLIES_RULE)).toBe(1)
    expect(count(jobs[0]!.prompt, opening)).toBe(0)
    for (const rule of [
      'A reply states nothing that is not already in the conversation or a tool result',
      'What your answer asks for, and what they left open, put off, gave in part or do not know, is never filled in',
      'An action they put on hold, typed or picked, is not offered now in any form',
      'Your earlier replies they did not pick are your words, never their decision or their answer',
    ]) {
      expect(count(runnerTurn.system, rule), rule).toBe(1)
      expect(count(runnerTurn.prompt, rule), rule).toBe(0)
    }
  })

  it('the first-line, reply-shape and to-the-person rules are each said once in their short form, and the reply rule leaves bubbles, links and register to the kept sentences', async () => {
    expect(VOICE_RULE.length).toBeLessThanOrEqual(650)
    expect(WORK_REPLY_RULE.length).toBeLessThanOrEqual(450)
    expect(TO_PERSON_RULE.length).toBeLessThanOrEqual(600)
    expect(TO_PERSON_RULE.endsWith(PLAIN_WORK_RULE)).toBe(true)
    const was = parent['lead-web'] as unknown as { system: string }
    const dir = await mkdtemp(join(tmpdir(), 'prompt-budget-'))
    scratch.push(dir)
    const jobs: ToolSessionJob[] = []
    await answer(await openWorld(dir, recorder(jobs)), '가족 모임 장소 후보 세 군데 비교해서 정리해줘')
    for (const text of [`${runnerTurn.system}\n${runnerTurn.prompt}`, `${jobs[0]!.system}\n${jobs[0]!.prompt}`]) {
      for (const rule of [VOICE_RULE, WORK_REPLY_RULE, TO_PERSON_RULE, ONE_BUBBLE_RULE]) expect(count(text, rule), rule.slice(0, 40)).toBe(1)
      for (const part of ['restates the job', 'one friendly line with the result', 'third person', 'plain everyday words', 'units and date formats']) expect(count(text, part), part).toBe(1)
      for (const old of ['Write to the person in the language of their message', 'addressing them in the second person', 'a blank line starts a new message bubble']) {
        expect(count(was.system, old), old).toBe(1)
        expect(count(text, old), old).toBe(0)
      }
    }
    expect(WORK_REPLY_RULE).not.toMatch(/bubble|empty line|link|-요|language/)
  })

  it('the colleague, file-job and prior-claim rules are each said once in their short form, every behaviour of the old text kept, and the choice rule untouched', async () => {
    expect(COLLEAGUE_CORE_RULE.length).toBeLessThanOrEqual(3300)
    expect(FILE_JOB_RULE.length).toBeLessThanOrEqual(1020)
    expect(PRIOR_CLAIM_RULE.length).toBeLessThanOrEqual(250)
    expect(COLLEAGUE_CORE_RULE.length + FILE_JOB_RULE.length + PRIOR_CLAIM_RULE.length).toBeLessThanOrEqual(4570)
    expect(COLLEAGUE_RULE).toBe([COLLEAGUE_CORE_RULE, CHOICE_RULE, FILE_JOB_RULE].join(' '))
    const was = parent['lead-web'] as unknown as { system: string }
    expect(count(was.system, CHOICE_RULE)).toBe(1)
    for (const prompt of [stepPrompt('반상회 공지 메모 짧게 다듬어줘', [], []), wrapUpPrompt('tidy the block meeting note', [])]) {
      expect(count(prompt, COLLEAGUE_RULE)).toBe(1)
      expect(count(prompt, PRIOR_CLAIM_RULE)).toBe(1)
    }
    const dir = await mkdtemp(join(tmpdir(), 'prompt-budget-'))
    scratch.push(dir)
    const jobs: ToolSessionJob[] = []
    await answer(await openWorld(dir, recorder(jobs)), '반상회 공지 메모 짧게 다듬어줘')
    for (const text of [`${runnerTurn.system}\n${runnerTurn.prompt}`, `${jobs[0]!.system}\n${jobs[0]!.prompt}`]) {
      for (const rule of [COLLEAGUE_CORE_RULE, CHOICE_RULE, FILE_JOB_RULE, PRIOR_CLAIM_RULE]) expect(count(text, rule), rule.slice(0, 40)).toBe(1)
      for (const part of [
        'at most one apology',
        'A one-fact ask, also from a file, gets one sentence naming any convention it rests on, nothing more unless asked',
        'told as a team would, who did what in a natural sentence',
        'one short human line, no offer of help, and mid-work a word on where it stands',
        'The answer is the first line',
        'kept as is after a few warm Korean words',
        'A changed ask names the new subject first',
        'one part asked is one part given',
        'an item is listed once',
        'sorted files are counts per kind',
        'figures read as spoken',
        'A reply asked for in another form is written again in it, every fact and constraint kept, no value guessed',
        'holds only what is in it',
        'A summary or tidy-up of a short note is answered in the chat',
        'After a file job, say in a few words what you chose',
        'An extraction ends with exactly one short offer line',
        'only when no earlier reply ended with an offer',
        'No offer after a correction, a simple fact, small talk or a short ask',
        'clearly marked blanks',
        'never invented figures',
        'one or two sentences on what is in it and the choice made',
        'Never say what you did not do or check unless asked',
        'unless a search or read this turn returned it',
        'when nothing earlier was found, say so',
      ]) expect(count(text, part), part).toBe(1)
      for (const old of ['tell it the way a team would', 'no asking or offering help in any wording', 'which you hand over unchanged', 'write that reply again in the asked form', 'Give no offer after a correction', 'search_chats, search_memory, find_skills or open_skill']) {
        expect(count(was.system, old), old).toBe(1)
        expect(count(text, old), old).toBe(0)
      }
    }
  })

  it('the persistence rule replaces the four old ones, the how-to-work block is short, the lookup kind keeps persistence and sources, and a menu with no web tool gets none of the web rules', async () => {
    const persist = `${PERSIST_RULE} ${PERSIST_WEB_RULE}`
    expect(persist.length).toBeLessThanOrEqual(900)
    const starts = [persist, 'Look in order:', 'On an open page, act before asking', 'Searching:', 'Before writing something the person writes again and again', REFERENCE_ID_RULE, 'What you say about the subject', 'You can make documents']
    const block = (system: string) => system.split('\n').filter(line => starts.some(start => line.startsWith(start)))
    expect(block(runnerTurn.system)).toHaveLength(starts.length)
    expect(block(runnerTurn.system).join('').length).toBeLessThanOrEqual(4446)
    const was = parent['lead-web'] as unknown as { system: string }
    const dir = await mkdtemp(join(tmpdir(), 'prompt-budget-'))
    scratch.push(dir)
    const jobs: ToolSessionJob[] = []
    await answer(await openWorld(dir, recorder(jobs)), '우리 동 주민센터 요가 교실 접수 기간 알아봐줘')
    for (const text of [`${runnerTurn.system}\n${runnerTurn.prompt}`, `${jobs[0]!.system}\n${jobs[0]!.prompt}`]) {
      expect(count(text, persist)).toBe(1)
      for (const part of [
        'Finish the job this turn and check each claim against what you read',
        'never end on a plan to try something: try it now',
        'A failed, empty or cut-short read or search is not proof: take another route to the same source',
        'Do every item asked without asking to continue',
        'Partial is only for a real barrier',
        'call ask_person and wait',
        'Never invent success, repeat a side effect or widen the ask',
        'reload, its own address and menus',
        'the official source, another reputable one, search results or news, a partial answer naming exactly what is missing',
        'a press that changes nothing was the wrong control',
        'their notebook (search_memory',
        'never for a value read this turn',
        'goes into the first search or address, not into a retry',
        'read a page listing newest first rather than searching again with dates',
        'note every condition first',
        'list an item only when its own page was read this turn',
        'Several found items go in one table, one row each, name first, link in the row',
        'the page beats your own knowledge',
        'marked unverified in the same sentence',
        'no substitute is passed off as it',
        'read a view that covers it or say first what was covered',
        'unverified and as of when',
        'act before asking',
        'Say something cannot be done only after words, point and look have failed',
        'match them field by field',
        'never save it half-filled',
        'is a reference, not a task',
        'unless they name one',
      ]) expect(count(text, part), part).toBe(1)
      for (const old of ['Keep going until the requested task is completely resolved', 'Do not stop at the first failure', 'When a source fails, go down the ladder', 'Where to look, in order', 'the app shows each row as a card', 'Web research uses search_web and open_page']) {
        expect(count(was.system, old), old).toBe(1)
        expect(count(text, old), old).toBe(0)
      }
      expect(count(was.system, 'Before recording an item as unverified')).toBe(2)
      expect(count(text, 'Before recording an item as unverified')).toBe(1)
    }
    const link = Object.keys(keep['lead-runner']!).find(sentence => sentence.startsWith('A fact read from a page or results carries a Markdown link'))!
    for (const name of ['lead-lookup', 'teammate', 'helper']) {
      for (const rule of [persist, link, 'What you say about the subject', 'Searching:']) expect(count(texts[name]!, rule), `${name}: ${rule.slice(0, 40)}`).toBe(1)
    }
    const bare = await lead('find when the community centre yoga class opens sign-ups', [tool('file_read')], { lookup: true })
    for (const text of [texts['lead-bare']!, bare.system]) {
      expect(count(text, PERSIST_RULE)).toBe(1)
      for (const web of [PERSIST_WEB_RULE, 'the ladder', 'Look in order:', 'Searching:', 'On an open page', 'What you say about the subject', 'search results or news']) expect(count(text, web), web).toBe(0)
    }
  })

  it('a sentence that is missing or doubled is caught', () => {
    const [sentence] = Object.keys(keep['lead-runner']!)
    const text = texts['lead-runner']!
    expect(count(text, sentence!)).toBe(1)
    expect(count(text.replace(sentence!, ''), sentence!)).not.toBe(1)
    expect(count(`${text}${sentence}`, sentence!)).not.toBe(1)
  })
})
