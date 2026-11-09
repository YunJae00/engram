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

  it.each(flagSets)('keeps chips from inventing a reason or a link between items (%#)', flags => {
    const line = sessionRules(flags).split('\n').find(l => l.includes('fenced block whose language is replies'))!
    expect(line).toContain('never states a reason, cause or link between items')
    expect(line).toContain('unless the person or a tool result said it')
    expect(line).toContain('a reference ID or two items in the same note is not a link')
    expect(line).toContain('asks for it or leaves it open in their voice')
    for (const chip of ['연기 이유 확인해줘', '이유는 비워둬']) expect(line).toContain(`"${chip}"`)
    expect(line).toContain('never "연기 이유는 "지난주 장애 때문"으로 넣어줘"')
    expect(line).toContain('never "박민수 기한은 11월 14일로 넣어줘"')
  })

  it.each(flagSets)('keeps chips from supplying a reason the answer asks for (%#)', flags => {
    const line = sessionRules(flags).split('\n').find(l => l.includes('fenced block whose language is replies'))!
    expect(line).toContain('When your answer asks the person for a value (a date, owner, amount, reason, cause or other detail), the replies must not supply that value for them')
    for (const chip of ['사유는 비워둬', '사유 정해지면 알려줄게']) expect(line).toContain(`"${chip}"`)
    expect(line).toContain('never 사유는 "일정상 테스트 기간 추가 필요"로 넣어줘')
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

  it('keeps chips from re-offering a deferred or undecided value, earlier candidates and unclicked chip values included', () => {
    expect(EARLIER_REPLIES_RULE).toContain('When the person deferred a value or put it on hold (일단 보류, 나중에), said they do not know it yet, or your answer shows it as undecided (미정, 아직 미정), no reply proposes a specific value for it')
    expect(EARLIER_REPLIES_RULE).toContain('not a candidate you listed earlier (such as 11/16, 11/19 or 11/23)')
    expect(EARLIER_REPLIES_RULE).toContain('not a value from an earlier reply they did not pick')
    expect(EARLIER_REPLIES_RULE).toContain('offer neutral defer or confirm options in their voice instead')
    for (const chip of ['마감 정해지면 알려줄게', '마감은 미정으로 둬줘', '후보 다시 보여줘']) expect(EARLIER_REPLIES_RULE).toContain(`"${chip}"`)
    expect(EARLIER_REPLIES_RULE).toContain('never "마감일 11/16로 확정해줘" or "마감일도 11/16으로 넣어서 다시 써줘"')
  })

  it('keeps chips from offering an action the person put on hold, such as sending the mail', () => {
    expect(EARLIER_REPLIES_RULE).toContain('When the person put an action or step on hold or deferred it (나중에 보낼게, 일단 보내지 마, 보류)')
    for (const action of ['sending', 'posting', 'submitting', 'scheduling', 'deleting', 'any other step']) expect(EARLIER_REPLIES_RULE).toContain(action)
    expect(EARLIER_REPLIES_RULE).toContain('no reply offers to do that action now')
    expect(EARLIER_REPLIES_RULE).toContain('the replies follow the request they did make, such as a rewrite')
    for (const chip of ['한 번 더 다듬어줘', '제목도 다듬어줘', '보낼 때 말할게']) expect(EARLIER_REPLIES_RULE).toContain(`"${chip}"`)
    expect(EARLIER_REPLIES_RULE).toContain('never "이제 메일 보내줘" or "이대로 보내줘"')
    for (const flags of flagSets) expect(sessionRules(flags)).toContain('no reply offers to do that action now')
  })

  it('keeps chips from retrying a held or failed step and from echoing the deferral back', () => {
    expect(EARLIER_REPLIES_RULE).toContain('Retrying a failed or held step counts as doing it now, and so does switching to another app or tool to do it')
    expect(EARLIER_REPLIES_RULE).toContain('never "Outlook 열었어, 다시 해줘" or "다른 메일 앱으로 해줘" after a hold')
    expect(EARLIER_REPLIES_RULE).toContain('or picked a deferral reply such as "나중에 할게"')
    expect(EARLIER_REPLIES_RULE).toContain('No reply repeats the deferral the person just made, such as "나중에 할게" right after they said 보류 or picked "나중에 할게"')
    expect(EARLIER_REPLIES_RULE).toContain('also when the step failed and no draft or result exists')
    for (const chip of ['보낼 때 말할게', '본문 한 번 더 다듬어줘']) expect(EARLIER_REPLIES_RULE).toContain(`"${chip}"`)
    expect(EARLIER_REPLIES_RULE).toContain('never "이제 메일 보내줘" or "이대로 보내줘"')
    expect(EARLIER_REPLIES_RULE).toContain('Before any hold, the replies to a failed step may still offer to retry, switch apps or defer')
    for (const flags of flagSets) expect(sessionRules(flags)).toContain('No reply repeats the deferral the person just made')
  })
})
