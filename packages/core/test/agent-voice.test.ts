import { describe, expect, it } from 'vitest'
import { openRuleLines, PLAIN_WORK_RULE, stepPrompt, wrapUpPrompt } from '../src/agent-prompt.js'

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
