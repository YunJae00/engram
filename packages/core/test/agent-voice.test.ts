import { describe, expect, it } from 'vitest'
import { stepPrompt, wrapUpPrompt } from '../src/agent-prompt.js'
import { PLAIN_WORK_RULE, PRIOR_CLAIM_RULE, skillIndexLines } from '../src/prompt.js'
import { openRuleLines } from './rules.js'
import { sessionRules } from './rules.js'
import { COLLEAGUE_CORE_RULE, NO_SELF_RESEARCH_RULE, PERSIST_RULE, PERSIST_WEB_RULE, VOICE_RULE } from '../src/prompt.js'

describe('a comet speaks to the person, not about them', () => {
  it('the open rules ask for direct, first-person progress lines and forbid third-person narration', () => {
    const rule = openRuleLines().find((line) => line.startsWith('Speak to the person directly'))
    expect(rule).toBeDefined()
    expect(rule).toMatch(/first person/)
    expect(rule).toMatch(/never about them in the third person/)
    expect(rule).toContain('사용자가')
    expect(rule).toContain('The user said')
  })

  it('one rule keeps tool names out of what the person reads, and a figure off a results page is linked to that results page', () => {
    const lines = openRuleLines()
    expect(lines.filter(line => line.includes('no tool or function names'))).toEqual([COLLEAGUE_CORE_RULE])
    expect(lines.some(line => line.startsWith('Never name internal tools'))).toBe(false)
    const prompt = lines.join('\n')
    expect(prompt).not.toContain('never a results address')
    expect(prompt).toContain("a results page's figure to its address")
    expect(COLLEAGUE_CORE_RULE).toContain('A fact read from a page or results carries a Markdown link to it')
  })
})

describe('a comet describes its work in plain words of the thread language', () => {
  const guided = [stepPrompt('문서 고쳐줘', [], []), wrapUpPrompt('문서 고쳐줘', [])]
  const open = [openRuleLines().join('\n'), stepPrompt('fix the doc', [], [], undefined, undefined, undefined, false), wrapUpPrompt('fix the doc', [], undefined, undefined, undefined, false)]

  it('asks non-English threads for plain words without English jargon or file internals', () => {
    expect(PLAIN_WORK_RULE).toMatch(/language other than English/)
    expect(PLAIN_WORK_RULE).toMatch(/say what you do in plain everyday words/)
    expect(PLAIN_WORK_RULE).toMatch(/not technical terms or file internals/)
    expect(PLAIN_WORK_RULE).toContain('zip/unzip')
    expect(PLAIN_WORK_RULE).toContain('바꿀 곳이 한 군데인 걸 확인했어요. 바꿔서 저장할게요.')
  })

  it('leaves English threads unchanged', () => {
    expect(PLAIN_WORK_RULE.startsWith('In a language other than English,')).toBe(true)
    expect(PLAIN_WORK_RULE).not.toMatch(/plain English/)
  })

  it('reaches guided and open step and wrap-up prompts alike', () => {
    for (const prompt of [...guided, ...open]) expect(prompt).toContain(PLAIN_WORK_RULE)
  })
})

describe('a comet sounds like a coworker who commits to the job', () => {
  const system = sessionRules({ engineId: 'claude', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false })
  const prompts = [system, openRuleLines().join('\n'), stepPrompt('t', [], [], undefined, undefined, undefined, false), wrapUpPrompt('t', [], undefined, undefined, undefined, false)]

  it('carries every voice rule into the session system prompt and open prompts', () => {
    for (const prompt of prompts) for (const rule of [VOICE_RULE, NO_SELF_RESEARCH_RULE, `${PERSIST_RULE} ${PERSIST_WEB_RULE}`]) expect(prompt).toContain(rule)
  })

  it('opens with the job and its outcome, and that line replaces naming what will be looked at first', () => {
    expect(VOICE_RULE).toMatch(/Otherwise one line before the first call restates the job and its outcome/)
    expect(VOICE_RULE).toContain('세 도시 날씨 조사해서 PDF로 정리해줄게요.')
    expect(VOICE_RULE).toMatch(/not a step or what you will look at first, whatever other rules ask/)
  })

  it('reports milestones and failed routes only, never internal checks', () => {
    expect(VOICE_RULE).toMatch(/Then a line only for a finished part, or for a failure and the new route/)
    expect(VOICE_RULE).toMatch(/Never narrate looking in memory/)
    expect(VOICE_RULE).toMatch(/memory, notes, past chats, how-tos, skills or tools/)
  })

  it('skips a saved way or skill that does not fit without a word', () => {
    expect(openRuleLines().find((line) => line.startsWith('A chore on a website'))).toMatch(/does not fit the job is skipped without a word/)
    expect(skillIndexLines([{ name: 'weather', description: 'd' }]).join('\n')).toContain('passed over without a word')
  })

  it('never researches Engram or other agent products on the web', () => {
    expect(NO_SELF_RESEARCH_RULE).toMatch(/Never search the web for Engram, this app, or other agent products/)
    expect(NO_SELF_RESEARCH_RULE).toContain('AgentX')
  })

  it('goes down a source ladder that ends in a partial answer, never a plan', () => {
    expect(PERSIST_WEB_RULE).toMatch(/the ladder: the official source, another reputable one, search results or news, a partial answer naming exactly what is missing/)
    expect(PERSIST_RULE).toMatch(/never end on a plan to try something: try it now/)
  })

  it('leads the final answer with the result, guided path included', () => {
    for (const prompt of prompts.slice(0, 2)) expect(prompt).toMatch(/When the job is done, reply as one short message in markdown with no blank line: first one friendly line with the result/)
    for (const prompt of prompts.slice(0, 2)) expect(prompt).toContain('The answer is the first line: no preface, steps or notes to yourself')
    expect(wrapUpPrompt('t', [])).toContain('Lead with the result, not with what was checked.')
  })

  it('drops the tool-preface line and keeps only the negated check example', () => {
    const speak = openRuleLines().find((line) => line.startsWith('Speak to the person directly'))
    expect(speak).not.toContain('확인해볼게요')
    for (const prompt of prompts) {
      expect(prompt).not.toContain('a line before using a tool')
      expect(prompt).not.toContain('which is optional')
      expect(prompt.split('확인해볼게요').length - 1).toBe(1)
    }
    expect(PRIOR_CLAIM_RULE).toMatch(/say nothing about checking \(never "메모와 대화 기록을 확인해볼게요\."\)/)
  })

  it('keeps a single third-person rule', () => {
    expect(openRuleLines().filter((line) => /third person/.test(line))).toHaveLength(1)
  })

  it('drafts a self-contained ask straight from what was given, without announcing a notes search', () => {
    expect(VOICE_RULE).toMatch(/A self-contained ask \(drafting, translating, summarizing what they gave\) is done from it with no search/)
    expect(VOICE_RULE).toMatch(/Never narrate looking in memory, notes, past chats/)
    expect(VOICE_RULE).toContain('"지난번"')
  })
})
