import { describe, expect, it } from 'vitest'
import { runToolSession } from '../src/agent-session.js'
import { COMMAND_STEP_RULE, EARLIER_REPLIES_RULE, OFFICE_FILE_RULE, PAGE_DELTA_RULE, REPLIES_RULE, sessionRules, sessionShape, TEXTING_RULE, WORK_REPLY_RULE } from '../src/agent-session-shape.js'
import { DESKTOP_TASK_RULE } from '../src/agent-prompt.js'
import { CHOICE_RULE, COLLEAGUE_CORE_RULE, FILE_JOB_RULE, RESULT_FIRST_RULE, TEAM_LEAD_RULE, VOICE_RULE } from '../src/agent-voice.js'
import { COLLECTION_RULE } from '../src/collection-progress.js'
import { DOCUMENT_CHECK_RULE } from '../src/office-verification.js'
import { LOOKUP_TOOLS } from '../src/team-hire-tools.js'
import type { Engine, EngineCwd, NativeTools, ToolSessionJob } from '../src/engine/types.js'
import { pageTools } from '../src/comet-page-tools.js'
import type { WebPage } from '../src/errand.js'

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
      // r2 (Codex r1 #1): it is sent whole pages (no deltas), so it carries no page-delta rule.
      expect(count(rules, PAGE_DELTA_RULE)).toBe(0)
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

// c13c r2 (Codex r1): the delta rule and the native file rules were gated by tools only, not by the turn kind.
describe('c13c r2: rules follow the turn kind, not just the tools offered', () => {
  const fileTools = ['file_read', 'find_files', 'file_create_copy', 'file_move', 'file_create_workbook', 'file_edit_package', 'open_page', 'read_open_page']
  it('a short ask or lookup with every file tool gets no make, hand-in, move, command, Office or delta rule, only where a named file is', () => {
    const work = sessionRules({ ...base, workflow: true, planned: true, kind: 'work', tools: fileTools })
    // stack-13: the approval mode line ("Commands run without asking.") is a gate and stays with the file tools; the how-to lines go.
    const make = (text: string): boolean => /file_create_copy|file_move|Commands are not|short script/.test(text)
    expect(make(work)).toBe(true)
    expect(count(work, PAGE_DELTA_RULE)).toBe(1)
    for (const kind of ['short', 'lookup'] as const) {
      const rules = sessionRules({ ...base, workflow: true, planned: true, kind, tools: fileTools })
      expect(make(rules)).toBe(false)
      for (const rule of [OFFICE_FILE_RULE, PAGE_DELTA_RULE, COMMAND_STEP_RULE]) expect(count(rules, rule)).toBe(0)
      expect(rules).toContain(`workspace folder is ${native.workspace}`)
    }
  })

  // Not a harness wording: a lookup scrolling one page three times.
  it('a lookup is sent whole pages, so it never sees a delta it has no rule for; a work turn still gets deltas', async () => {
    const page = (revision: number): WebPage => ({ url: 'https://example.com/', title: '시간표', text: Array.from({ length: 24 }, (_, n) => `${n}번 줄 ${n === 9 ? `값 ${revision}` : ''} ${'변하지 않는 내용. '.repeat(3)}`).join('\n'), controls: ['#1 [button] 다음'], observation: { page: 'one', document: 1, revision } })
    const reads = async (options: Parameters<typeof runToolSession>[2]): Promise<string[]> => {
      let revision = 0
      const tools = pageTools({}, { fetchPage: async () => page(0), readOpen: async () => page(++revision), scroll: async () => ({ ok: true, changed: true }) })
      tools.push({ name: 'open_page', description: '', argsSchema: {}, run: async () => 'unused' })
      const sent: string[] = []
      const engine = { id: 'mock', runTools: async (job: ToolSessionJob) => {
        const scroll = job.tools.find(tool => tool.name === 'scroll')!
        for (let i = 0; i < 3; i++) sent.push(String(await scroll.run({ to: 'down' })))
        return { answer: '찾았어요' }
      } } as Engine
      await runToolSession({ engine, tools, workdir: '.' as EngineCwd }, '이 페이지 시간표 끝까지 읽어줘', options)
      return sent
    }
    expect((await reads({})).some(text => text.includes('delta from'))).toBe(true)
    for (const options of [{ lookup: true }, { short: true }]) expect((await reads(options)).some(text => text.includes('delta from'))).toBe(false)
  })
})

// c13c r3 (Codex r2 #2): DOCUMENT_CHECK_RULE was still gated by Office tools alone. Every act flag is now off for a non-work turn, so a short
// ask or a lookup offered every capability gets exactly the rules it gets with none, beyond what its tool list itself names.
describe('c13c r3: a short ask or a lookup gets no act rule, whatever flags and tools it has', () => {
  const every = ['file_read', 'find_files', 'file_create_copy', 'file_move', 'file_create_workbook', 'file_edit_package', 'file_read_package', 'word_write', 'ppt_build', 'excel_write', 'open_page', 'read_open_page', 'read_pages', 'page_steps', 'page_do', 'search_web', 'desktop_sequence']
  it('all flags on equals all flags off, and holds no Office, receipt, desktop or download rule', () => {
    for (const kind of ['short', 'lookup'] as const) {
      const on = sessionRules({ ...base, desktop: true, workflow: true, browser: true, planned: true, pageSteps: true, pageDo: true, kind, tools: every })
      const off = sessionRules({ ...base, workflow: false, planned: false, kind, tools: every })
      expect(on).toBe(off)
      for (const rule of [DOCUMENT_CHECK_RULE, OFFICE_FILE_RULE, COLLECTION_RULE, DESKTOP_TASK_RULE, PAGE_DELTA_RULE]) expect(count(on, rule)).toBe(0)
      // stack-13: the download approval line is a gate: it follows the page tool, whatever the turn kind.
      expect(count(on, 'For a requested file download')).toBe(1)
    }
    const work = sessionRules({ ...base, desktop: true, workflow: true, browser: true, planned: true, pageSteps: true, pageDo: true, kind: 'work', tools: every })
    for (const rule of [DOCUMENT_CHECK_RULE, OFFICE_FILE_RULE, COLLECTION_RULE, DESKTOP_TASK_RULE, PAGE_DELTA_RULE]) expect(count(work, rule)).toBe(1)
  })
  it('a short ask offered a page tool is opened without the receipt tool or rule', async () => {
    const jobs: ToolSessionJob[] = []
    const engine = { id: 'claude', desktopToolIsolation: true, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: '네' } } } as unknown as Engine
    const tools = ['open_page', 'read_open_page', 'file_read'].map(name => ({ name, description: name, argsSchema: {}, run: async () => '' }))
    await runToolSession({ engine, workdir: '/tmp' as EngineCwd, tools }, '이 링크 제목만 말해줘', { short: true })
    expect(count(jobs[0]!.system, COLLECTION_RULE)).toBe(0)
    expect(jobs[0]!.tools.some(tool => tool.name === 'collect_results')).toBe(false)
  })
})

// stack-13: a small-talk or told turn is short yet is offered every tool and the person's files (ipc: no desk menu, native on). The act
// how-to goes, the gates of what it holds stay: sandbox, command approval, delete, desktop send and approval, download approval.
describe('stack-13: a gate follows the tools a session holds, never the turn kind', () => {
  const every = ['file_read', 'file_create_copy', 'file_move', 'open_page', 'app_press', 'app_set', 'desktop_sequence', 'search_web']
  it('a short or lookup session holding files and desktop tools keeps their gates; one holding neither gets none', async () => {
    const { DESKTOP_GATE_RULE } = await import('../src/agent-prompt.js')
    for (const kind of ['short', 'lookup'] as const) {
      const holds = sessionRules({ ...base, workflow: false, planned: false, kind, tools: every })
      expect(count(holds, DESKTOP_GATE_RULE), kind).toBe(1)
      expect(holds).toContain('Deleting a file of theirs is never done without asking first.')
      expect(holds).toContain(`make new files only inside ${native.cwd}`)
      expect(count(holds, DESKTOP_TASK_RULE)).toBe(0)
      expect(holds).not.toContain('file_create_copy (name plus fromPath)')
      const bare = sessionRules({ engineId: 'claude', desktop: false, browser: false, pageSteps: false, workflow: false, planned: false, kind, tools: ['search_web', 'read_pages'] })
      expect(count(bare, DESKTOP_GATE_RULE)).toBe(0)
      expect(bare).not.toContain('Deleting a file of theirs')
    }
    // Every gate sentence is DESKTOP_TASK_RULE's own, so a work session that has the whole rule loses nothing.
    for (const sentence of DESKTOP_GATE_RULE.split(/(?<=\.) /)) expect(DESKTOP_TASK_RULE.toLowerCase()).toContain(sentence.replace(/;.*$/, '').toLowerCase().replace(/\.$/, ''))
  })
})
