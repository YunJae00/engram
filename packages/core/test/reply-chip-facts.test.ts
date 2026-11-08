import { describe, expect, it } from 'vitest'
import { EARLIER_REPLIES_RULE, sessionRules } from '../src/agent-session-shape.js'

const flagSets = [
  { engineId: 'mock', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false },
  { engineId: 'mock', desktop: true, workflow: true, browser: true, planned: true, pageSteps: true, pageDo: true },
]

describe('replies block facts rule', () => {
  it.each(flagSets)('forbids unsupported facts and asks for unknown values (%#)', flags => {
    const line = sessionRules(flags).split('\n').find(l => l.includes('fenced block whose language is replies'))
    expect(line).toBeDefined()
    expect(line).toContain('A reply states no fact that is not already in the conversation or tool results')
    for (const word of ['date', 'deadline', 'owner', 'amount', 'name', 'place', 'address', 'any other detail']) expect(line).toContain(word)
    expect(line).toContain('question or a request to confirm instead of an assertion')
    expect(line).toContain('in the language of the request')
    expect(line).toContain('기한 확인 필요')
    expect(line).toContain('박민수 기한 확인해줘')
    expect(line).toContain('the two or three things the person is most likely to say next')
    expect(line).toContain('never English for a request written in another language')
  })

  it.each(flagSets)('keeps chips from answering the question the answer asks (%#)', flags => {
    const line = sessionRules(flags).split('\n').find(l => l.includes('fenced block whose language is replies'))!
    expect(line).toContain('When your answer asks the person for a value')
    expect(line).toContain('the replies must not supply that value for them')
    expect(line).toContain('not-known, defer or confirm options')
    expect(line).toContain('기한 아직 모름')
    expect(line).toContain('Suggested replies from your earlier answers are not facts the person gave')
  })

  it.each(flagSets)('keeps chips from filling in a partly known or unknown time (%#)', flags => {
    const line = sessionRules(flags).split('\n').find(l => l.includes('fenced block whose language is replies'))!
    for (const word of ['time', 'hour', 'minute']) expect(line).toContain(word)
    expect(line).toContain('When the person gives only part of a value (a day, or 오후 without an hour)')
    expect(line).toContain('must not fill in the missing part with a specific value')
    expect(line).toContain('when the person says they do not know a value yet, no reply supplies it')
    expect(line).toContain('아직 시간 모름')
    expect(line).toContain('시간 정해지면 알려줄게')
    expect(line).toContain('never "시간은 오후 2시로 해줘"')
  })

  it.each(flagSets)('keeps unclicked earlier chips from becoming the person\'s decision (%#)', flags => {
    const line = sessionRules(flags).split('\n').find(l => l.includes('fenced block whose language is replies'))!
    expect(line).toContain(EARLIER_REPLIES_RULE)
  })

  it('states what an unclicked earlier chip may and may not decide', () => {
    expect(EARLIER_REPLIES_RULE).toContain('```replies')
    expect(EARLIER_REPLIES_RULE).toContain('that the person did not pick are your words, not theirs')
    for (const word of ['date', 'deadline', 'owner', 'amount']) expect(EARLIER_REPLIES_RULE).toContain(word)
    expect(EARLIER_REPLIES_RULE).toContain('is never the person\'s decision')
    expect(EARLIER_REPLIES_RULE).toContain('as set or confirmed (such as 확정됨) only when the person wrote it or picked a reply that states it')
    expect(EARLIER_REPLIES_RULE).toContain('otherwise it stays unknown (미정)')
    expect(EARLIER_REPLIES_RULE).toContain('new replies do not build on it')
  })

  it('covers any detail from an unclicked chip in replies and recaps, not only dates and owners', () => {
    expect(EARLIER_REPLIES_RULE).toContain('any detail that appears only there')
    for (const word of ['period or quarter', '분기', 'data source or file', '엑셀 파일', 'format', 'recipient', 'any other fact']) expect(EARLIER_REPLIES_RULE).toContain(word)
    expect(EARLIER_REPLIES_RULE).toContain('never the person\'s decision or answer')
    expect(EARLIER_REPLIES_RULE).toContain('In a reply, recap or summary never list it as settled (지금까지 확정된 내용) or state it as what the person said')
    expect(EARLIER_REPLIES_RULE).toContain('never treat it as something they said earlier that you must now correct')
  })
})
