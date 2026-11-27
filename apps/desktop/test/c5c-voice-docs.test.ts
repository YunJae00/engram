import { readFileSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadBotMemory, mergeMemory, PERSON_MEMORY, PROFILE_NOTE_ID, profileLines, runToolSession, type AgentLoopOptions, type Engine, type EngineCwd, type ToolSessionJob, type VaultPaths } from 'core'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/home', isPackaged: false }, ipcMain: { handle: () => {} } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

import * as firstLine from '../src/main/first-line.js'
const FIRST_LINE_FUNCTIONS = ['beginFirstLine', 'cleanLine', 'endFirstLine', 'firstLineCarried', 'firstLineReady', 'firstLineSaw', 'firstLineSpoke', 'firstLineState', 'wantsFirstLine', 'warmFirstLine']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
const answerSetInTurn = (ipc: string): number => ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('afterAnswer = async () => {')).split('result.answer = ').length - 1
import { cleanLine } from '../src/main/first-line.js'
import { quickPrompt } from './ack-prompt.js'
import { learningTools } from '../src/main/learning-wiring.js'

const source = (name: string) => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8')
const core = (name: string) => readFileSync(new URL(`../../../packages/core/src/${name}`, import.meta.url), 'utf8')
const COLLEAGUE_RULE = core('prompt.ts')
async function turn(draft: string, said: string, options: AgentLoopOptions = {}) {
  const jobs: ToolSessionJob[] = [], voiced: string[] = []
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } }, quick: async (prompt: string) => { voiced.push(prompt); return '안녕하세요!' } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: '/tmp/c5c-voice' as EngineCwd, tools: [] }, said, options)
  return { posted: result.answer, voiced, told: jobs.map(job => `${job.system}\n${job.prompt}\n${job.opening ?? ''}`).join('\n') }
}

describe('a document ask makes the document (D3, D4, D5)', () => {
  it('tells a document ask to make the document, not ask about it, on the one menu, and leaves the real gates where they are', () => {
    expect(COLLEAGUE_RULE).toContain('A document they ask for is made, not asked about')
    expect(COLLEAGUE_RULE).toContain('never offer a menu of options or ask how they want it when one reasonable choice exists')
    expect(source('answer.ts')).toContain('[...everyTool, escalate]')
    expect(source('answer.ts')).not.toMatch(/DESK_TOOLS|deskKind/)
    expect(core('prompt.ts')).toContain('A control that would submit, save, send or buy is pressed like any other - the app stops there itself')
    expect(core('comet-page-tools.ts')).toContain('The page needs the person to sign in or pass a check.')
  })
  it('tells the turn to make the file with marked blanks, say the choice, and never ask or invent', () => {
    for (const part of ['A document they ask for is made, not asked about', 'clearly marked blanks where the real numbers go ("수치 입력")', 'never invented figures', 'never offer a menu of options', '실제 수치는 비워 두고 5장 틀로 만들었어요.']) expect(COLLEAGUE_RULE, part).toContain(part)
  })
  it('changes the deck made earlier in the thread, the same file', () => {
    expect(core('document-tools.ts')).toContain('give name the same file name and the file in the task folder is replaced in place and stays one file')
    const ipc = source('ipc.ts')
    expect(ipc).toContain('const earlierOutputs = bot ? await linkedOutputs(artifactDirectory(paths), [...savedHistory')
    expect(ipc).toContain('context: () => ({ company, handedBack, attachments: attachments.context, recovery, turn: turn?.context, team: team.note(channel), outputs: priorOutputLines(earlierOutputs)')
  })
  it('opens a document turn with its first step and closes with what is in the file (D2, D4 judge)', () => {
    const line = quickPrompt('위 회의록으로 워드 보고서 만들어줘', true)
    expect(line).toContain('for a document it is the first thing done with what the request names ("매출 파일부터 볼게요.", never "보고서 작성해볼게요.")')
    expect(quickPrompt('Make a report from the notes', false)).toContain('never "Making the report now."')
    expect(COLLEAGUE_RULE).toContain('never with the kind of file and that it was made ("보고서 만들었어요.", "엑셀 만들었어요.")')
  })
})

describe('a kept fact is corrected by the model\'s own keep_in_mind call (M2)', () => {
  const kept = ['이름은 권윤재다', '지민호랑 같이 일한다']
  const fix = { old: '지민호랑 같이 일한다', fact: '민호랑 같이 일한다' }
  it('stores it through keep_in_mind, and the old value is gone from memory and from the note', async () => {
    await mkdir(resolve('tmp'), { recursive: true })
    const root = await mkdtemp(resolve('tmp/c5c-keep-'))
    const paths = { root, workspace: root, cache: join(root, '.engram'), notes: join(root, 'notes') } as unknown as VaultPaths
    await mkdir(paths.notes, { recursive: true })
    const keep = learningTools(paths, 'bot-1', () => '').find(tool => tool.name === 'keep_in_mind')!
    await keep.run({ facts: kept }, { task: '' })
    expect((await loadBotMemory(paths, PERSON_MEMORY)).facts.map(fact => fact.text)).toContain(fix.old)
    await keep.run({ facts: [fix.fact], replaces: [fix.old], scope: 'everyone' }, { task: '아 지민호 말고 민호야' })
    const now = (await loadBotMemory(paths, PERSON_MEMORY)).facts.map(fact => fact.text)
    expect(now).toEqual(['이름은 권윤재다', '민호랑 같이 일한다'])
    const note = profileLines(await readFile(join(paths.notes, `${PROFILE_NOTE_ID}.md`), 'utf8'))
    expect(note.join('\n')).not.toContain('지민호')
    expect(note).toContain('민호랑 같이 일한다')
  })
  it('takes the old value out of the person\'s memory and the teammate\'s own, whichever scope the correction names', async () => {
    for (const scope of ['everyone', 'this bot']) {
      const root = await mkdtemp(resolve('tmp/c5c-both-'))
      const paths = { root, workspace: root, cache: join(root, '.engram'), notes: join(root, 'notes') } as unknown as VaultPaths
      await mkdir(paths.notes, { recursive: true })
      const keep = learningTools(paths, 'bot-1', () => '').find(tool => tool.name === 'keep_in_mind')!
      await keep.run({ facts: kept }, { task: '' })
      await keep.run({ facts: kept, scope: 'this bot' }, { task: '' })
      const read = async () => mergeMemory(await loadBotMemory(paths, PERSON_MEMORY), await loadBotMemory(paths, '1')).facts.map(fact => fact.text)
      expect((await loadBotMemory(paths, '1')).facts.map(fact => fact.text).join(' ')).toContain('지민호')
      await keep.run({ facts: [fix.fact], replaces: [fix.old], scope }, { task: '아 지민호 말고 민호야' })
      for (const id of [PERSON_MEMORY, '1']) expect((await loadBotMemory(paths, id)).facts.map(fact => fact.text).join(' '), `${scope} ${id}`).not.toContain('지민호')
      expect((await read()).join(' '), scope).toContain('민호랑 같이 일한다')
      expect((await loadBotMemory(paths, PERSON_MEMORY)).facts.map(fact => fact.text), scope).toContain('민호랑 같이 일한다')
      expect(profileLines(await readFile(join(paths.notes, `${PROFILE_NOTE_ID}.md`), 'utf8')).join('\n'), scope).not.toContain('지민호')
    }
  })
  it('is never made by the host: answer has no correction of its own and ipc hands it no kept facts to correct with', () => {
    const own = source('answer.ts')
    for (const gone of ['keptFix', 'keepAsk', 'fixArgs', 'remembered', 'shared']) expect(own, gone).not.toContain(gone)
    expect(source('ipc.ts')).not.toContain('shared: personMemory.facts.map(fact => fact.text),')
    expect(own).not.toMatch(/deskLight|light: true|modelHint/)
  })
})

describe('small talk never sounds like a help desk (Q1)', () => {
  it('a greeting is answered whole by the quick tier, whose prompt says never to ask or offer help, like the lead\'s rule; a line is shown as written', () => {
    expect(COLLEAGUE_RULE).toContain('no asking or offering help in any wording')
    const prompt = quickPrompt('주말 잘 보내셨어요?', true)
    expect(prompt).toContain('Answer in full yourself only when the reply needs nothing but this message and common knowledge (a greeting')
    expect(prompt).toContain('with no emoji, question back or offer of help')
    for (const said of ['안녕하세요! 뭘 도와드릴까요.', '안녕하세요! 오늘은 무엇을 도와드릴까요?', '좋은 아침이에요. 뭐 도와드릴까요?', '안녕하세요! 도와드릴 일 있으면 말씀하세요.', '반가워요. 필요하신 게 있으면 말씀해 주세요.', 'Hi there! How can I help you today?', '무엇을 도와드릴까요?']) expect(cleanLine(said), said).toBe(said)
    for (const none of ['  ', '안녕하세요!\n좋은 아침이에요.']) expect(cleanLine(none), none).toBeUndefined()
  })
  it('leaves a colleague\'s line as it is', async () => {
    for (const said of ['안녕하세요! 좋은 아침이에요.', '별말씀을요. 더 필요한 거 있으면 말씀하세요.', '회의록부터 읽어볼게요.', '거의 다 찾았어요, 금방 올릴게요.']) expect(cleanLine(said), said).toBe(said)
    expect((await turn('안녕하세요!\n\n좋은 하루 보내세요.', '안녕')).posted).toBe('안녕하세요!\n\n좋은 하루 보내세요.')
  })
  it('describes the pattern in the prompts, not one string, and the main model\'s small talk is posted as it wrote it', async () => {
    expect(COLLEAGUE_RULE).toMatch(/help in any wording/)
    expect(COLLEAGUE_RULE).toContain('뭘 도와드릴까요')
    expect(source('first-line.ts')).not.toMatch(/smallTalkPrompt|SMALL_TALK/)
    expect(answerSetInTurn(source('ipc.ts'))).toBe(0)
    expect(functionsOf(firstLine)).toEqual(FIRST_LINE_FUNCTIONS)
    for (const said of ['뭘 도와드릴까요?', '안녕하세요! 뭘 도와드릴까요?', '안녕하세요! 좋은 아침이에요.', 'How can I help you today?']) {
      const { posted, told, voiced } = await turn(said, '안녕')
      expect(posted, said).toBe(said)
      expect(told).toMatch(/help in any wording/)
      expect(voiced).toEqual([])
    }
  })
})

describe('a line in another language is led by a few Korean words (Q3, c11b)', () => {
  const ask = '"회의 늦어서 죄송합니다"를 정중한 영어 이메일 한 줄로 써줘', line = 'I apologize for being late to the meeting.'
  it('puts the lead on the same line when the answer has no Hangul (c11b: asked of the model)', async () => {
    for (const answer of [line, `${line}\n\n\`\`\`replies\n더 짧게\n\`\`\``, 'Hi Minho,\n\nSorry for the delay.']) {
      const { posted, told } = await turn(answer, ask)
      expect(posted, answer).toBe(answer)
      expect(told).toContain('text they asked for in another language, which you hand over unchanged after a few warm Korean words')
    }
  })
  it('keeps a rewording to the earlier line\'s facts and constraints, and posts its opening as written (c11b: asked of the model)', async () => {
    expect(COLLEAGUE_RULE).toContain('write that reply again in the asked form with every fact and every constraint of the original ask kept')
    for (const answer of ['이건 어때요? I apologize for being late.', '이렇게 쓰면 돼요. My sincere apologies for the delay.']) expect((await turn(answer, '다르게 써줘')).posted, answer).toBe(answer)
  })
  it('adds nothing when the answer has Korean, has no words, or the person wrote in English (c11b: the host adds nothing at all)', async () => {
    for (const answer of [`이렇게 쓰면 돼요. ${line}`, '정중하게는 "I apologize"가 좋아요.', line, '31,536,000', '']) expect((await turn(answer, ask)).posted, answer).toBe(answer)
    expect(source('ipc.ts')).not.toContain('koreanLead')
  })
})

describe('a marked blank is one the deck check lets through (D3)', () => {
  it('names the wording that passes, and the check agrees', async () => {
    const { auditDeck } = await import('../../../packages/core/src/deck-audit.js')
    expect(COLLEAGUE_RULE).toContain('clearly marked blanks where the real numbers go ("수치 입력")')
    expect(auditDeck([{ title: '3분기 핵심 지표', bullets: ['매출: 수치 입력', '영업이익: 수치 입력'] }])).toEqual([])
    for (const blank of ['주요 성과: 내용 입력', '[수치 입력]']) expect(auditDeck([{ title: '3분기 핵심 지표', bullets: [blank] }]), blank).toHaveLength(1)
  })
})

describe('a follow-up names what it points at (H1)', () => {
  it('asks for the thing to be resolved from the thread, never asked about, and for no promise to keep track', () => {
    expect(COLLEAGUE_RULE).toContain('never ask which one they mean when the thread already says it')
    expect(COLLEAGUE_RULE).toContain('no promise about later conversations')
    expect(COLLEAGUE_RULE).not.toMatch(/쪽으로 챙겨 둘게요|will keep it in mind/)
  })
})

describe('an extraction ends with one short offer, once per thread (H4)', () => {
  const ask = 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘'
  const answer = '할 일만 뽑았어요.\n\n- 한서연: 온보딩 화면 시안 확정 (11월 20일)\n- 오태민: 결제 모듈 교체 일정 수립 (11월 24일)'
  const offer = '원하시면 담당자별로도 나눠 드릴게요.'
  const desk: AgentLoopOptions = {}
  it('the one line of at most 60 characters is asked of the model, and what it writes is posted with nothing added', async () => {
    const { posted, told } = await turn(answer, ask, desk)
    expect(posted).toBe(answer)
    expect(told).toContain('ends with exactly ONE short offer line of something new that would really help')
    expect(told).toContain(`("${offer}")`)
    expect([...offer].length).toBeLessThanOrEqual(60)
    for (const own of [`${answer}\n\n${offer}`, '- 38%\n- 12명', '| 담당 | 할 일 |\n|---|---|\n| 한서연 | 시안 확정 |', `${answer}\n\n${offer}\n\n\`\`\`replies\n표로\n\`\`\``]) expect((await turn(own, ask, desk)).posted, own).toBe(own)
    expect(existsSync(new URL('../src/main/desk-lane.ts', import.meta.url))).toBe(false)
  })
  it('an answer that offers, and one in a thread that already had an offer, are both posted as written; the model sees the earlier reply and the once-only rule', async () => {
    for (const closing of ['원하시면 담당자별로도 나눠 드릴게요.', '표로도 정리해 드릴까요?']) expect((await turn(`${answer}\n\n${closing}`, ask, desk)).posted).toBe(`${answer}\n\n${closing}`)
    const { posted, told } = await turn(answer, ask, { ...desk, history: [{ role: 'user', text: '회의록 요약해줘' }, { role: 'assistant', text: '요약했어요.\n\n원하시면 워드 파일로도 만들어 드릴게요.' }] })
    expect(posted).toBe(answer)
    expect(told).toContain('원하시면 워드 파일로도 만들어 드릴게요.')
    expect(told).toContain('only when none of your earlier replies in this conversation ended with an offer')
  })
  it('never adds one to another kind of turn', async () => {
    for (const other of ['엔비디아 오늘 주가 알려줘', '1년은 몇 초야?', '안녕', '고마워 수고했어', 'fixtures/meeting-notes.md 회의록 요약해서 결정사항이랑 할 일 정리해줘', 'fixtures/sales.csv에서 12월 매출 합계 알려줘',
      '빵집 세 군데에 하나씩 물어봐', '챙길 것 세 가지만 골라줘', '등산 모임 회칙을 문서 파일에 담아줘']) expect((await turn(answer, other)).posted, other).toBe(answer)
    expect((await turn(answer, '연락선 첫 배가 언제 떠?')).told).toContain('Give no offer after a correction, a simple fact, small talk or a short ask.')
    expect(answerSetInTurn(source('ipc.ts'))).toBe(0)
  })
})
