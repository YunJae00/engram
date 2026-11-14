import { describe, expect, it } from 'vitest'
import { openRuleLines, PLAIN_WORK_RULE, PRIOR_CLAIM_RULE, skillIndexLines, stepPrompt, wrapUpPrompt } from '../src/agent-prompt.js'
import { sessionRules } from '../src/agent-session-shape.js'
import { FALLBACK_LADDER_RULE, NO_SELF_RESEARCH_RULE, RESULT_FIRST_RULE, VOICE_RULE } from '../src/agent-voice.js'

describe('a comet speaks to the person, not about them', () => {
  it('the open rules ask for direct, first-person progress lines and forbid third-person narration', () => {
    const rule = openRuleLines().find((line) => line.startsWith('Speak to the person directly'))
    expect(rule).toBeDefined()
    expect(rule).toMatch(/first person/)
    expect(rule).toMatch(/never about them in the third person/)
    expect(rule).toContain('사용자가')
    expect(rule).toContain('The user asked')
  })

  it('the open rules forbid internal tool names in what the person reads and ask for plain words', () => {
    const rule = openRuleLines().find((line) => line.startsWith('Never name internal tools or functions'))
    expect(rule).toBeDefined()
    expect(rule).toMatch(/what the person reads/)
    expect(rule).toContain('word_read')
    expect(rule).toContain('word_edit')
    expect(rule).toMatch(/plain words/)
    expect(rule).toMatch(/in their language/)
    expect(rule).toContain('문서를 읽고 수정했어요')
  })
})

describe('a comet describes its work in plain words of the thread language', () => {
  const guided = [stepPrompt('문서 고쳐줘', [], []), wrapUpPrompt('문서 고쳐줘', [])]
  const open = [openRuleLines().join('\n'), stepPrompt('fix the doc', [], [], undefined, undefined, undefined, false), wrapUpPrompt('fix the doc', [], undefined, undefined, undefined, false)]

  it('asks non-English threads for plain words without English jargon or file internals', () => {
    expect(PLAIN_WORK_RULE).toMatch(/language other than English/)
    expect(PLAIN_WORK_RULE).toMatch(/in their language with plain everyday words/)
    expect(PLAIN_WORK_RULE).toMatch(/not English technical terms or file internals/)
    expect(PLAIN_WORK_RULE).toContain('zip/unzip')
    expect(PLAIN_WORK_RULE).toContain('바꿀 곳이 한 군데인 걸 확인했어요. 바꿔서 저장할게요.')
  })

  it('leaves English threads unchanged', () => {
    expect(PLAIN_WORK_RULE).toMatch(/in an English thread this rule does not apply/)
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
    for (const prompt of prompts) for (const rule of [VOICE_RULE, NO_SELF_RESEARCH_RULE, FALLBACK_LADDER_RULE, RESULT_FIRST_RULE]) expect(prompt).toContain(rule)
  })

  it('opens with the job and its outcome, and that line replaces naming what will be looked at first', () => {
    expect(VOICE_RULE).toMatch(/first line to the person restates the job and the outcome/)
    expect(VOICE_RULE).toContain('세 도시 날씨 조사해서 PDF로 정리해줄게요.')
    expect(VOICE_RULE).toMatch(/not a step and not what you will look at first/)
    expect(VOICE_RULE).toMatch(/one short sentence said before the first tool call; it takes the place of naming what you will look at first, and wherever another rule asks for that, give this line instead/)
  })

  it('reports milestones and failed routes only, never internal checks', () => {
    expect(VOICE_RULE).toMatch(/only when a part is finished/)
    expect(VOICE_RULE).toMatch(/what failed and the new route, in one sentence/)
    expect(VOICE_RULE).toMatch(/Never narrate looking in memory/)
    expect(VOICE_RULE).toMatch(/saved procedures or how-tos, skills/)
    expect(VOICE_RULE).toMatch(/scope of your tools/)
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
    expect(FALLBACK_LADDER_RULE).toMatch(/the official source, then another reputable source, then search results or news coverage, then a partial answer that says exactly what is missing/)
    expect(FALLBACK_LADDER_RULE).toMatch(/never end on a plan to try something/)
  })

  it('leads the final answer with the result, guided path included', () => {
    expect(RESULT_FIRST_RULE).toMatch(/the final answer leads with the result/)
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
})
