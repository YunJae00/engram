import { describe, expect, it } from 'vitest'
import { runToolSession } from '../src/agent-session.js'
import { COMMAND_STEP_RULE, EARLIER_REPLIES_RULE, OFFICE_FILE_RULE, PAGE_DELTA_RULE, REPLIES_RULE, sessionRules, sessionShape, TEXTING_RULE, WORK_REPLY_RULE } from '../src/agent-session-shape.js'
import { DESKTOP_TASK_RULE } from '../src/agent-prompt.js'
import { CHOICE_RULE, COLLEAGUE_CORE_RULE, FILE_JOB_RULE, RESULT_FIRST_RULE, TEAM_LEAD_RULE, VOICE_RULE } from '../src/agent-voice.js'
import { COLLECTION_RULE } from '../src/collection-progress.js'
import { DOCUMENT_CHECK_RULE } from '../src/office-verification.js'
import { LOOKUP_TOOLS } from '../src/team-hire-tools.js'
import type { Engine, EngineCwd, NativeTools, ToolSessionJob } from '../src/engine/types.js'

// c13c cause P: every session carried the whole desk/browser rule set (37-48k chars), and a short ask got three reply-shape rules that
// disagreed ("just the line" vs "two to four messages" vs "say what you chose"). Rules are now chosen by the tools a session has and the
// kind of turn it serves; asserted by rule identity, not by phrases.
const native = { cwd: '/vault/workspace/tasks/bot-1', mode: 'auto', workspace: '/vault/workspace' } as NativeTools
const base = { engineId: 'claude', desktop: false, browser: false, pageSteps: false, native }
const SHORT_MENU = ['keep_in_mind', 'search_memory', 'read_note', 'search_chats', 'file_read', 'find_files', 'ask_person', 'report_result_check']
const LANE_MENU = ['hire_members', 'review_member', 'team_status', 'search_web', 'read_pages', 'open_page', 'read_open_page', 'search_memory', 'read_note', 'search_chats', 'ask_person']
const NOTE_MENU = SHORT_MENU
const DECK_MENU = ['ppt_build', 'word_write', 'file_read', 'file_read_package', 'file_edit_package', 'file_read_workbook', 'file_create_workbook', 'file_create_copy', 'find_files', 'render_file', 'search_web', 'read_pages', 'search_memory', 'read_note', 'report_result_check']
const count = (text: string, rule: string): number => text.split(rule).length - 1
const WORK_ONLY = [WORK_REPLY_RULE, REPLIES_RULE, CHOICE_RULE, FILE_JOB_RULE, VOICE_RULE, TEXTING_RULE, COMMAND_STEP_RULE, RESULT_FIRST_RULE]

describe('c13c: a session is sent the rules for its tools and its turn kind', () => {
  const teammate = sessionRules({ ...base, workflow: false, planned: true, kind: 'lookup', tools: [...LOOKUP_TOOLS] })
  const lone = sessionRules({ ...base, native: undefined, workflow: false, planned: true, kind: 'lookup', tools: LANE_MENU })
  const short = sessionRules({ ...base, workflow: true, planned: true, kind: 'short', tools: SHORT_MENU })
  const note = sessionRules({ ...base, workflow: true, planned: true, kind: 'work', tools: NOTE_MENU })
  const deck = sessionRules({ ...base, workflow: true, planned: true, kind: 'work', tools: DECK_MENU })

  it('a lookup gets no receipt, file, Office, desktop or work-reply rule', () => {
    for (const rules of [teammate, lone]) {
      for (const rule of [COLLECTION_RULE, OFFICE_FILE_RULE, DOCUMENT_CHECK_RULE, DESKTOP_TASK_RULE, ...WORK_ONLY]) expect(count(rules, rule)).toBe(0)
      expect(count(rules, COLLEAGUE_CORE_RULE)).toBe(1)
      // It reads pages, so the page rules it can act on stay.
      expect(count(rules, PAGE_DELTA_RULE)).toBe(1)
    }
    expect(count(teammate, TEAM_LEAD_RULE)).toBe(0)
    expect(count(lone, TEAM_LEAD_RULE)).toBe(1)
  })

  it('a short ask gets no reply-shape rule of its own: the host note is the one owner', () => {
    for (const rule of [COLLECTION_RULE, OFFICE_FILE_RULE, DOCUMENT_CHECK_RULE, DESKTOP_TASK_RULE, PAGE_DELTA_RULE, ...WORK_ONLY]) expect(count(short, rule)).toBe(0)
    expect(count(short, COLLEAGUE_CORE_RULE)).toBe(1)
  })

  it('work keeps exactly one reply-shape rule and the choice rule, and Office rules only with Office tools', () => {
    for (const rules of [note, deck]) {
      expect(count(rules, WORK_REPLY_RULE)).toBe(1)
      expect(count(rules, REPLIES_RULE)).toBe(1)
      expect(count(rules, CHOICE_RULE)).toBe(1)
      expect(count(rules, COLLECTION_RULE)).toBe(0)
    }
    expect(count(note, OFFICE_FILE_RULE)).toBe(0)
    expect(count(deck, OFFICE_FILE_RULE)).toBe(1)
    expect(count(deck, DOCUMENT_CHECK_RULE)).toBe(1)
  })

  it('fits a char budget per kind (before c13c: short 30.0k, lookup teammate 28.7k, lone lookup 25.9k, desk note 30.0k)', () => {
    expect(short.length).toBeLessThan(7_000)
    expect(teammate.length).toBeLessThan(12_500)
    expect(lone.length).toBeLessThan(12_500)
    expect(note.length).toBeLessThan(23_000)
  })

  it('with no tool list or kind it is the full work set, so a session warmed ahead matches a default comet', () => {
    const full = sessionRules({ ...base, workflow: true, planned: true })
    for (const rule of [WORK_REPLY_RULE, CHOICE_RULE, OFFICE_FILE_RULE, COMMAND_STEP_RULE, TEAM_LEAD_RULE]) expect(count(full, rule)).toBe(1)
  })
})

describe('c13c: the turn kind reaches the session from its options', () => {
  const run = async (options: Parameters<typeof runToolSession>[2], names = SHORT_MENU): Promise<ToolSessionJob> => {
    const jobs: ToolSessionJob[] = []
    const engine = { id: 'claude', desktopToolIsolation: true, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: '休暇' } } } as unknown as Engine
    const tools = names.map(name => ({ name, description: name, argsSchema: {}, run: async () => '' }))
    // "‘내일 휴가입니다’를 일본어 한 줄로" is not a harness wording.
    await runToolSession({ engine, workdir: '/tmp' as EngineCwd, tools }, '‘내일 휴가입니다’를 일본어 한 줄로', options)
    return jobs[0]!
  }
  it('a short ask has no multi-message rule, no "say what you chose" and no suggested-replies rules', async () => {
    const job = await run({ short: true })
    for (const rule of [WORK_REPLY_RULE, CHOICE_RULE, REPLIES_RULE, EARLIER_REPLIES_RULE]) expect(count(`${job.system}\n${job.prompt}`, rule)).toBe(0)
  })
  it('a lookup has none of them either; a plain turn has each once', async () => {
    const lookup = await run({ lookup: true }, LANE_MENU)
    for (const rule of [WORK_REPLY_RULE, CHOICE_RULE, REPLIES_RULE, COLLECTION_RULE]) expect(count(`${lookup.system}\n${lookup.prompt}`, rule)).toBe(0)
    const work = await run({})
    expect(count(work.system, WORK_REPLY_RULE)).toBe(1)
    expect(count(work.system, CHOICE_RULE)).toBe(1)
    expect(count(work.prompt, EARLIER_REPLIES_RULE)).toBe(1)
  })
  it('the warmed shape and a default work session render the same rules for the same tools', async () => {
    const work = await run({}, DECK_MENU)
    const engine = { id: 'claude' } as Engine
    const shape = sessionShape({ engine, tools: DECK_MENU.map(name => ({ name, description: name, argsSchema: {}, run: async () => '' })) })
    expect(shape.system).toBe(work.system)
  })
})
