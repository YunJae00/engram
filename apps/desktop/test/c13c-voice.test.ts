import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sessionRules, WORK_REPLY_RULE, REPLIES_RULE, CHOICE_RULE } from 'core'
import { DESK_NOTE, DESK_TOOLS, deskKind, fileGiven, reshapeAsk, reshapePrompt } from '../src/main/desk-lane.js'
import { SHORT_QUESTION_NOTE } from '../src/main/fast-lane.js'

// c13c cause P. Wordings here are not the harness's.
const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')

describe('c13c: a short ask has one owner for its reply shape', () => {
  it('the host note owns it, says the line stands alone, and the session sends no work reply rule', () => {
    expect(SHORT_QUESTION_NOTE).toContain('nothing after it: no line on what it means, why it fits or how you chose it')
    expect(ipc).toContain('...([SHORT_QUESTION_NOTE, SMALL_TALK_NOTE, TOLD_NOTE].includes(laneNote) ? { short: true } : {}),')
    const ask = '‘내일 휴가입니다’를 일본어 한 줄로 써줘'
    const kind = deskKind(ask)
    expect(kind === 'ask' || kind === 'question').toBe(true)
    const tools = [...(DESK_TOOLS[kind!] ?? [])]
    const system = sessionRules({ engineId: 'claude', desktop: false, workflow: true, browser: false, planned: true, pageSteps: false, kind: 'short', tools })
    for (const rule of [WORK_REPLY_RULE, REPLIES_RULE, CHOICE_RULE]) expect(system).not.toContain(rule)
    // Short-ask session + its note, without history or memory.
    expect(system.length + SHORT_QUESTION_NOTE.length).toBeLessThan(10_500)
  })
})

describe('c13c: reshape returns the asked form and "shorter" is checked', () => {
  const LAST = 'Thank you so much for your help with the launch yesterday.'
  const voice = (out: object | string) => async (): Promise<string> => typeof out === 'string' ? out : JSON.stringify(out)
  it('the same text back for "shorter" is no reshape: the turn takes its normal route', async () => {
    expect(await reshapeAsk('더 간단하게', LAST, voice({ form: 'shorter', was: LAST, reply: LAST }))).toBeUndefined()
    expect(await reshapeAsk('더 간단하게', LAST, voice({ form: 'shorter', was: LAST, reply: `${LAST} ` }))).toBeUndefined()
  })
  it('a really shorter reply is taken', async () => {
    expect(await reshapeAsk('좀 줄여봐', LAST, voice({ form: 'shorter', was: LAST, reply: 'Thanks for your help with the launch.' }))).toBe('Thanks for your help with the launch.')
  })
  it('commentary does not count as content: an explanation line plus the same sentence is not shorter', async () => {
    const last = `이렇게 쓰면 돼요. ${LAST}\n출시를 도와준 데 감사하는 뜻을 담은 문장이에요.`
    expect(await reshapeAsk('더 간단하게', last, voice({ form: 'shorter', was: LAST, reply: `감사 인사예요.\n${LAST}` }))).toBeUndefined()
    // A "was" that is not in the last reply cannot be checked.
    expect(await reshapeAsk('더 간단하게', last, voice({ form: 'shorter', was: 'Thanks a lot for everything you did for us all this year.', reply: 'Thanks!' }))).toBeUndefined()
  })
  // c13c r3 (Codex r2 #1): the voice copied the whole last reply as "was" and dropped only the explanation; not a harness wording.
  it('a reply cut word for word out of the last reply is no shorter form, whatever "was" says', async () => {
    const line = '明日は休みをいただきます。'
    const last = `이렇게 보내면 돼요. "${line}" 내일 휴가라는 뜻을 공손하게 전하는 문장이에요.`
    for (const reply of [line, `"${line}"`, `이렇게 보내면 돼요. "${line}"`]) expect(await reshapeAsk('조금만 줄여줘', last, voice({ form: 'shorter', was: last, reply }))).toBeUndefined()
    expect(await reshapeAsk('조금만 줄여줘', last, voice({ form: 'shorter', was: last, reply: '"明日休みます。"' }))).toBe('"明日休みます。"')
  })
  it('a table is not length-checked, and an unknown form or plain text is no reshape', async () => {
    const table = '| 내용 |\n|---|\n| 출시 도움 감사 |'
    expect(await reshapeAsk('표로 바꿔줘', LAST, voice({ form: 'table', was: LAST, reply: table }))).toBe(table)
    expect(await reshapeAsk('표로 바꿔줘', LAST, voice({ form: 'poem', reply: table }))).toBeUndefined()
    expect(await reshapeAsk('표로 바꿔줘', LAST, voice(table))).toBeUndefined()
  })
  it('the prompt asks for the asked thing only, with no commentary', () => {
    const prompt = reshapePrompt('더 간단하게', LAST)
    expect(prompt).toContain('"form"')
    expect(prompt).toContain('no line on what it means or why')
    expect(prompt).not.toContain('the same facts and nothing else')
  })
})

describe('c13c: notes separate a decision from an action item by meaning', () => {
  // A note whose 결정사항 heading lists owner+due items, and a leaning that is no decision.
  const note = ['# 디자인 주간 회의', '', '## 논의', '- 로고 시안 세 개를 봤고 C안 쪽 의견이 많았다.', '', '## 결정사항', '1. 로고 최종 파일 정리 — 담당: 김하늘, 기한: 12월 3일', '2. 브랜드 가이드 초안 공유 — 담당: 이준, 기한: 12월 5일'].join('\n')
  it('the rule the model gets says what each list means, so the host needs no per-line patch', () => {
    const prompt = [DESK_NOTE, fileGiven({ name: 'design-notes.md', text: note })].join('\n\n')
    expect(prompt).toContain('a decision (결정사항) is what the meeting settled - a choice, a direction or a commitment - and an action item (할 일) is who does what by when')
    expect(prompt).toContain('an item with an owner and a due date is an action item')
    expect(prompt).toContain('is said as a leaning, never as 확정 or as a decision')
    expect(prompt).toContain('The content decides, not the notes\' own headings')
    expect(prompt).toContain('C안 쪽 의견이 많았다')
  })
})
