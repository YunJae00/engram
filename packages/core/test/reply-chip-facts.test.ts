import { describe, expect, it } from 'vitest'
import { REPLIES_RULE } from '../src/prompt.js'
import { sessionRules } from './rules.js'

const flagSets = [
  { engineId: 'mock', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false },
  { engineId: 'mock', desktop: true, workflow: true, browser: true, planned: true, pageSteps: true, pageDo: true },
]
const lineOf = (flags: (typeof flagSets)[number]) => sessionRules(flags).split('\n').find(l => l.includes('fenced block whose language is replies'))!
const NO_NEW_FACT = 'A reply states nothing that is not already in the conversation or a tool result'
const NOT_FILLED = 'What your answer asks for, and what they left open, put off, gave in part or do not know, is never filled in'
const HELD = 'An action they put on hold, typed or picked, is not offered now in any form'
const EARLIER = 'Your earlier replies they did not pick are your words, never their decision or their answer'

describe('replies block facts rule', () => {
  it.each(flagSets)('forbids unsupported facts and asks for unknown values (%#)', flags => {
    const line = lineOf(flags)
    expect(line).toContain(REPLIES_RULE)
    expect(line).toContain(NO_NEW_FACT)
    for (const word of ['date', 'time', 'owner', 'amount', 'name', 'place']) expect(line).toContain(word)
    expect(line).toContain('ask instead, such as "박민수 기한 확인해줘", never "박민수 기한은 11월 14일로 넣어줘"')
    expect(line).toContain('the two or three things the person is most likely to say next')
    expect(line).toContain('never English for a request written in another language')
  })

  it.each(flagSets)('keeps chips from answering the question the answer asks (%#)', flags => {
    expect(lineOf(flags)).toContain(`${NOT_FILLED}, not even with a candidate you listed: offer not-known, later or confirm options in their voice`)
  })

  it.each(flagSets)('keeps chips from filling in a partly known or unknown time (%#)', flags => {
    const line = lineOf(flags)
    expect(line).toContain('gave in part or do not know')
    expect(line).toContain('such as "시간 정해지면 알려줄게", never "시간은 오후 2시로 해줘"')
  })

  it.each(flagSets)('keeps chips from inventing a reason or a link between items (%#)', flags => {
    expect(lineOf(flags)).toContain('and no reason or link between items (a shared note or ID is not a link)')
  })

  it.each(flagSets)('keeps chips from supplying a reason the answer asks for (%#)', flags => {
    const line = lineOf(flags)
    expect(line).toContain('no reason or link between items')
    expect(line).toContain(NOT_FILLED)
  })

  it.each(flagSets)('keeps unclicked earlier chips from becoming the person\'s decision (%#)', flags => {
    expect(lineOf(flags)).toContain(EARLIER)
  })

  it('states each of the four rules once, after the first sentence', () => {
    const first = REPLIES_RULE.indexOf('the app shows them as buttons.')
    for (const rule of [NO_NEW_FACT, NOT_FILLED, HELD, EARLIER]) {
      expect(REPLIES_RULE.split(rule), rule).toHaveLength(2)
      expect(REPLIES_RULE.indexOf(rule)).toBeGreaterThan(first)
    }
  })

  it('states what an unclicked earlier chip may and may not decide', () => {
    expect(REPLIES_RULE).toContain(`${EARLIER}:`)
    expect(REPLIES_RULE).toContain('stays 미정')
    expect(REPLIES_RULE).toContain('new replies do not build on it')
  })

  it('covers any detail from an unclicked chip in replies and recaps, not only dates and owners', () => {
    expect(REPLIES_RULE).toContain(`${EARLIER}: a detail only there stays 미정 in any reply or recap, and new replies do not build on it.`)
  })

  it('keeps chips from re-offering a deferred or undecided value, earlier candidates included', () => {
    expect(REPLIES_RULE).toContain('put off')
    expect(REPLIES_RULE).toContain('not even with a candidate you listed')
  })

  it('keeps chips from offering an action the person put on hold, such as sending the mail', () => {
    expect(REPLIES_RULE).toContain(`${HELD}, not as a retry and not in another app`)
    expect(REPLIES_RULE).toContain('the replies follow what they did ask, such as "한 번 더 다듬어줘", never "이대로 보내줘"')
    for (const flags of flagSets) expect(sessionRules(flags)).toContain(HELD)
  })

  it('keeps chips from retrying a held or failed step and from echoing the deferral back', () => {
    expect(REPLIES_RULE).toContain('not as a retry and not in another app, even after it failed, and their deferral is not repeated back')
    for (const flags of flagSets) expect(sessionRules(flags)).toContain('their deferral is not repeated back')
  })
})
