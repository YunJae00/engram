import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runToolSession, sessionRules, WORK_REPLY_RULE, REPLIES_RULE, CHOICE_RULE, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import * as deskLane from '../src/main/desk-lane.js'
const DESK_FUNCTIONS = ['askNow', 'closingBuilds', 'deskKind', 'deskLane', 'deskLight', 'fileGiven', 'fixSlideTitle', 'isCorrection', 'keptFix', 'kindSortAsk', 'namedText', 'onlyTells', 'plainKeep', 'routeAsk', 'slideTitleFix', 'sortByKind']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
import { DESK_NOTE, DESK_TOOLS, deskKind, fileGiven } from '../src/main/desk-lane.js'
import { SHORT_QUESTION_NOTE } from '../src/main/fast-lane.js'

const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')

describe('c13c: a short ask has one owner for its reply shape', () => {
  it('the host note owns it, says the line stands alone, and the session sends no work reply rule', () => {
    expect(SHORT_QUESTION_NOTE).toContain('nothing after it: no line on what it means, why it fits or how you chose it')
    expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).toContain('...([SHORT_QUESTION_NOTE, SMALL_TALK_NOTE, TOLD_NOTE].includes(laneNote) ? { short: true } : {}),')
    const ask = '‘내일 휴가입니다’를 일본어 한 줄로 써줘'
    const kind = deskKind(ask)
    expect(kind === 'ask' || kind === 'question').toBe(true)
    const tools = [...(DESK_TOOLS[kind!] ?? [])]
    const system = sessionRules({ engineId: 'claude', desktop: false, workflow: true, browser: false, planned: true, pageSteps: false, kind: 'short', tools })
    for (const rule of [WORK_REPLY_RULE, REPLIES_RULE, CHOICE_RULE]) expect(system).not.toContain(rule)
    expect(system.length + SHORT_QUESTION_NOTE.length).toBeLessThan(10_500)
  })
})

describe('c13c: a reshape is the model\'s reply in the asked form, posted as written', () => {
  const LAST = 'Thank you so much for your help with the launch yesterday.'
  async function reshape(said: string, last: string, draft: string) {
    const jobs: ToolSessionJob[] = [], voiced: string[] = []
    const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } }, quick: async (prompt: string) => { voiced.push(prompt); return 'NO' } } as unknown as Engine
    const result = await runToolSession({ engine, workdir: '/tmp/c13c-voice' as EngineCwd, tools: [] }, said, { short: true, attachmentContext: SHORT_QUESTION_NOTE, history: [{ role: 'user', text: '출시 도와줘서 고맙다는 영어 한 줄 써줘' }, { role: 'assistant', text: last }] })
    return { posted: result.answer, calls: jobs.length, voiced, told: jobs.map(job => `${job.system}\n${job.prompt}\n${job.opening ?? ''}`).join('\n') }
  }
  it('the same text back for "shorter" is posted too: the host compares nothing and the turn is one model call', async () => {
    const { posted, calls, voiced } = await reshape('더 간단하게', LAST, LAST)
    expect(posted).toBe(LAST)
    expect(calls).toBe(1)
    expect(voiced).toEqual([])
  })
  it('a really shorter reply is posted as written', async () => {
    expect((await reshape('좀 줄여봐', LAST, 'Thanks for your help with the launch.')).posted).toBe('Thanks for your help with the launch.')
  })
  it('commentary is the model\'s to leave out: it is told so, and an explanation line it still writes is posted with the sentence', async () => {
    const last = `이렇게 쓰면 돼요. ${LAST}\n출시를 도와준 데 감사하는 뜻을 담은 문장이에요.`
    const draft = `감사 인사예요.\n${LAST}`
    const { posted, told } = await reshape('더 간단하게', last, draft)
    expect(told).toContain('and nothing about what you changed')
    expect(told).toContain('nothing after it: no line on what it means, why it fits or how you chose it')
    expect(posted).toBe(draft)
    expect((await reshape('더 간단하게', last, 'Thanks!')).posted).toBe('Thanks!')
  })
  it('a reply cut word for word out of the last reply is posted like any other, quotes and all', async () => {
    const line = '明日は休みをいただきます。'
    const last = `이렇게 보내면 돼요. "${line}" 내일 휴가라는 뜻을 공손하게 전하는 문장이에요.`
    for (const reply of [line, `"${line}"`, `이렇게 보내면 돼요. "${line}"`, '"明日休みます。"']) expect((await reshape('조금만 줄여줘', last, reply)).posted, reply).toBe(reply)
  })
  it('stack-13 (c13c r3 #1): "shorter" is measured by nobody: the last reply is in front of the model, and the desk lane holds no reshape', async () => {
    const asked = 'Thanks again for covering my shift on Friday.'
    const last = `${asked}\n금요일 근무를 대신해 줘서 고맙다는 뜻이에요.`
    const inline = `이렇게 쓰면 돼요. "${asked}" 고맙다는 뜻을 담았어요.`
    for (const before of [last, inline]) for (const reply of ['Thanks again for covering my shift on Friday!', 'Thanks for covering Friday.']) {
      const { posted, told } = await reshape('좀 줄여봐', before, reply)
      expect(posted).toBe(reply)
      expect(told).toContain(asked)
    }
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
  })
  it('a table is posted byte for byte, and so is plain text: no form is read out of the reply', async () => {
    const table = '| 내용 |\n|---|\n| 출시 도움 감사 |'
    expect((await reshape('표로 바꿔줘', LAST, table)).posted).toBe(table)
    const wrapped = JSON.stringify({ form: 'poem', reply: table })
    expect((await reshape('표로 바꿔줘', LAST, wrapped)).posted).toBe(wrapped)
    expect(ipc).not.toMatch(/reshape/i)
  })
  it('the turn asks for the asked thing only, with no commentary, and for no wrapper around it', async () => {
    const { told } = await reshape('더 간단하게', LAST, 'Thanks!')
    expect(told).toContain('When they ask for your last reply in another form (shorter, as a table, another tone or language), write that reply again in the asked form')
    expect(told).toContain('no line on what it means, why it fits or how you chose it')
    expect(told).toContain(LAST)
    expect(told).not.toContain('"form"')
  })
})

describe('c13c: notes separate a decision from an action item by meaning', () => {
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
