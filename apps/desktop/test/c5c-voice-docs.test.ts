import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadBotMemory, mergeMemory, PERSON_MEMORY, PROFILE_NOTE_ID, profileLines, type VaultPaths } from 'core'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/home', isPackaged: false }, ipcMain: { handle: () => {} } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

import { DESK_NOTE, DESK_TOOLS, deskKind, deskLight, keptFix, TOLD_NOTE, withOffer } from '../src/main/desk-lane.js'
import { SHORT_QUESTION_NOTE, SMALL_TALK_NOTE } from '../src/main/fast-lane.js'
import { cleanLine, firstLinePrompt, koreanLead, smallTalkPrompt, talkOnly, toldPrompt, withoutHelpDesk } from '../src/main/first-line.js'
import { learningTools } from '../src/main/learning-wiring.js'

const source = (name: string) => readFileSync(new URL(`../src/main/${name}`, import.meta.url), 'utf8')
const core = (name: string) => readFileSync(new URL(`../../../packages/core/src/${name}`, import.meta.url), 'utf8')
const COLLEAGUE_RULE = core('agent-voice.ts')

// grokbar cycle 5 (stack4-5e3ab16e), rows D1, D3-D5, M2, Q1, Q3, H1, H4.
describe('a document ask makes the document (D3, D4, D5)', () => {
  it('gives the document kind no way to ask, and leaves the real gates where they are', () => {
    expect(deskKind('다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적')).toBe('deck')
    // r2: Word and Excel asks ran with every tool, ask_person among them. They take the same menu, which still has what D2 and D4 used.
    for (const ask of ['위 회의록으로 워드 보고서 만들어줘', 'fixtures/sales.csv로 월별 합계 엑셀 만들고 차트도 넣어줘', '회의록 요약해서 워드로 만들어줘', '서울 날씨 조사해서 엑셀로 만들어줘', 'Make an Excel sheet of monthly totals from fixtures/sales.csv', 'fixtures/meeting-notes.md에서 할 일 뽑아서 워드로 만들어줘']) {
      expect(deskKind(ask), ask).toBe('deck')
      expect(DESK_TOOLS[deskKind(ask)!]!.has('ask_person'), ask).toBe(false)
    }
    for (const tool of ['word_write', 'file_create_workbook', 'file_read', 'file_read_workbook']) expect(DESK_TOOLS.deck!.has(tool), tool).toBe(true)
    // Sent somewhere, a how-to question, a question about a named file, or only a file's name: not this menu.
    for (const ask of ['회의록 워드로 만들어서 민호한테 메일로 보내줘', '엑셀에서 행 추가하는 법 알려줘', '엑셀 표 만드는 방법이 뭐야?', 'fixtures/budget.xlsx에서 합계 알려줘', 'fixtures/word.md 수정할 부분 알려줘']) expect(deskKind(ask), ask).not.toBe('deck')
    // stack-5: a document ask that also sends, posts, deletes or buys keeps every tool (the question tool and the page tools, where those gates are); a plain one keeps the menu.
    for (const ask of ['3분기 실적 PPT 만들어서 민호한테 메일로 보내줘', 'PPT 5장 만들고 슬랙에 게시해줘', '새 PPT 만들고 예전 발표 자료는 삭제해줘', '발표 자료 만들고 템플릿도 결제해줘', 'Make a deck and send it to Minho', '월별 합계 엑셀 만들고 원본은 지워줘']) {
      expect(deskKind(ask), ask).not.toBe('deck')
      expect(DESK_TOOLS[deskKind(ask)!]?.has('ask_person') ?? true, ask).toBe(true)
    }
    for (const ask of ['다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적', '팀원들한테 보여줄 PPT 만들어줘', '결제 모듈 교체 일정 PPT 만들어줘', '방금 만든 PPT 3번 슬라이드 제목 "핵심 지표"로 바꿔줘']) expect(deskKind(ask), ask).toBe('deck')
    // r3: a Word or Excel file named only by its file name, and a request that ends in "?", still had ask_person.
    for (const ask of ['fixtures/budget.xlsx 수정해줘', 'report.docx 고쳐줘', 'fixtures/budget.xlsx에 12월 행 추가해줘', 'notes.doc 제목 바꿔줘', 'Fix the totals in budget.xlsx',
      '분기 매출 엑셀로 만들어 줄래?', '회의록으로 워드 보고서 만들어 줄 수 있어?', 'report.docx 좀 고쳐주실래요?', 'Can you make an Excel sheet of monthly totals?']) {
      expect(deskKind(ask), ask).toBe('deck')
      expect(DESK_TOOLS[deskKind(ask)!]!.has('ask_person'), ask).toBe(false)
    }
    for (const tool of ['file_read_package', 'file_edit_package']) expect(DESK_TOOLS.deck!.has(tool), tool).toBe(true)
    // Still not this menu: a question about the file, a how-to that names a file, a file that is sent, an extension that only looks alike.
    for (const ask of ['budget.xlsx 합계 수정됐어?', '엑셀로 차트도 만들 수 있어?', 'budget.xlsx에 행 추가하는 법 알려줘', 'report.docx 고쳐서 민호한테 보내줘', 'fixtures/notes.docs.md 수정할 부분 알려줘']) expect(deskKind(ask), ask).not.toBe('deck')
    expect(DESK_TOOLS.deck!.has('ask_person')).toBe(false)
    for (const tool of ['ppt_build', 'word_write', 'file_create_workbook', 'find_files']) expect(DESK_TOOLS.deck!.has(tool), tool).toBe(true)
    // Sending, saving outside and buying stop in the app itself; a sign-in ask comes from the page tools, which the deck menu does not hold.
    expect(core('agent-prompt.ts')).toContain('A control that would submit, save, send or buy is pressed like any other - the app stops there itself')
    expect(core('comet-page-tools.ts')).toContain('The page needs the person to sign in or pass a check.')
    for (const tool of ['open_page', 'press', 'type_text']) expect(DESK_TOOLS.deck!.has(tool), tool).toBe(false)
  })
  it('tells the turn to make the file with marked blanks, say the choice, and never ask or invent', () => {
    for (const part of ['is made in this turn, never asked about', 'clearly marked blanks where the real numbers go ("수치 입력")', 'never invent a figure', 'Look at most once for a source file they plainly mean, and do not search memory first',
      'Never ask what to put in it and never give a list of options', '실제 수치는 비워 두고 5장 틀로 만들었어요.']) expect(DESK_NOTE, part).toContain(part)
    expect(COLLEAGUE_RULE).toContain('A document they ask for is made, not asked about')
  })
  it('changes the deck made earlier in the thread, the same file', () => {
    expect(deskKind('방금 만든 PPT 3번 슬라이드 제목 "핵심 지표"로 바꿔줘')).toBe('deck')
    for (const tool of ['file_read_package', 'file_edit_package']) expect(DESK_TOOLS.deck!.has(tool), tool).toBe(true)
    expect(DESK_NOTE).toContain('change that same file, the one in the list of files you saved earlier: never make a second copy')
    // The thread's own files are found from the links in its earlier answers and listed for every turn, a desk turn included (core priorOutputs: prior-outputs.test.ts).
    const ipc = source('ipc.ts')
    expect(ipc).toContain('const earlierOutputs = bot ? await linkedOutputs(artifactDirectory(paths), [...savedHistory')
    expect(ipc).toMatch(/attachmentContext: \[company, attachments\.context, recovery, turn\?\.context, team\.note\(channel\), priorOutputLines\(earlierOutputs\)/)
  })
  it('opens a document turn with its first step and closes with what is in the file (D2, D4 judge)', () => {
    const line = firstLinePrompt('위 회의록으로 워드 보고서 만들어줘', true)
    expect(line).toContain('the step is the first thing done with what the request names, never the document plus "-해볼게요"')
    expect(line).toContain('"회의록 내용부터 추릴게요.", "매출 파일부터 볼게요."')
    expect(line).toContain('never "보고서 작성해볼게요.", "엑셀 파일 만들어볼게요."')
    expect(firstLinePrompt('Make a report from the notes', false)).toContain('never "Making the report now."')
    for (const rule of [DESK_NOTE, COLLEAGUE_RULE]) expect(rule).toContain('never with the kind of file and that it was made ("보고서 만들었어요.", "엑셀 만들었어요.")')
  })
})

describe('a kept fact is corrected by the host (M2)', () => {
  const kept = ['이름은 권윤재다', '지민호랑 같이 일한다']
  it('replaces the whole word in the one fact that holds it', () => {
    expect(keptFix('아 지민호 말고 민호야', kept)).toEqual({ old: '지민호랑 같이 일한다', fact: '민호랑 같이 일한다', answer: '민호로 고쳤어요.' })
    expect(keptFix('지민호가 아니라 민호예요.', ['동료 이름은 지민호 님이다'])).toEqual({ old: '동료 이름은 지민호 님이다', fact: '동료 이름은 민호 님이다', answer: '민호로 고쳤어요.' })
    expect(keptFix('아니, 김민준 말고 박서준이야', ['담당자는 김민준입니다'])?.answer).toBe('박서준으로 고쳤어요.')
  })
  it('never changes a word that only sits inside another, and leaves the rest to the model', () => {
    // 민호 is inside 지민호: no "지수" for half a name, no "지민민호".
    expect(keptFix('아 민호 말고 수야', kept)).toBeUndefined()
    // No kept fact holds it; two do; nothing changes; not this shape.
    expect(keptFix('아 박지성 말고 민호야', kept)).toBeUndefined()
    expect(keptFix('아 지민호 말고 민호야', [...kept, '지민호 님 생일은 3월이다'])).toBeUndefined()
    expect(keptFix('아 민호 말고 민호야', ['민호랑 같이 일한다'])).toBeUndefined()
    for (const said of ['지민호 말고 민호한테 메일 보내줘', '민호야', '아 그거 말고 11월 걸로 해줘']) expect(keptFix(said, kept), said).toBeUndefined()
    // A particle that follows the old word's final consonant would read wrong after the new one.
    expect(keptFix('지민호 말고 수진이야', ['지민호와 같이 일한다'])).toBeUndefined()
  })
  it('stores it through keep_in_mind, and the old value is gone from memory and from the note', async () => {
    await mkdir(resolve('tmp'), { recursive: true })
    const root = await mkdtemp(resolve('tmp/c5c-keep-'))
    const paths = { root, workspace: root, cache: join(root, '.engram'), notes: join(root, 'notes') } as unknown as VaultPaths
    await mkdir(paths.notes, { recursive: true })
    const keep = learningTools(paths, 'bot-1', () => '').find(tool => tool.name === 'keep_in_mind')!
    await keep.run({ facts: kept }, { task: '' })
    const known = (await loadBotMemory(paths, PERSON_MEMORY)).facts.map(fact => fact.text)
    const fix = keptFix('아 지민호 말고 민호야', known)!
    await keep.run({ facts: [fix.fact], replaces: [fix.old], scope: 'everyone' }, { task: '아 지민호 말고 민호야' })
    const now = (await loadBotMemory(paths, PERSON_MEMORY)).facts.map(fact => fact.text)
    expect(now).toEqual(['이름은 권윤재다', '민호랑 같이 일한다'])
    // What a new thread reads (M3).
    const note = profileLines(await readFile(join(paths.notes, `${PROFILE_NOTE_ID}.md`), 'utf8'))
    expect(note.join('\n')).not.toContain('지민호')
    expect(note).toContain('민호랑 같이 일한다')
    expect(fix.answer).not.toMatch(/저장|기억/)
  })
  // r2: M1 kept the fact for everyone and the teammate held its own copy; the correction changed one, and a new thread read both names.
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
      const fix = keptFix('아 지민호 말고 민호야', await read())!
      await keep.run({ facts: [fix.fact], replaces: [fix.old], scope }, { task: '아 지민호 말고 민호야' })
      for (const id of [PERSON_MEMORY, '1']) expect((await loadBotMemory(paths, id)).facts.map(fact => fact.text).join(' '), `${scope} ${id}`).not.toContain('지민호')
      expect((await read()).join(' '), scope).toContain('민호랑 같이 일한다')
      expect((await loadBotMemory(paths, PERSON_MEMORY)).facts.map(fact => fact.text), scope).toContain('민호랑 같이 일한다')
      expect(profileLines(await readFile(join(paths.notes, `${PROFILE_NOTE_ID}.md`), 'utf8')).join('\n'), scope).not.toContain('지민호')
    }
  })
  it('is made before the model is asked, and remember turns that reach the model do not think long', () => {
    const ipc = source('ipc.ts')
    expect(ipc).toContain("const fix = !handed && kind === 'keep' ? keptFix(request.message, remembered) : undefined")
    expect(ipc).toContain("scope: personMemory.facts.some(fact => fact.text === fix.old) ? 'everyone' : 'this bot'")
    expect(ipc).toMatch(/: fixed \? \{ answer: fixed, steps: \[\{ tool: 'keep_in_mind', args: fixArgs!, observation: 'Kept 1 for later conversations\.' \}\], fellBack: false \}\n/)
    expect(ipc).toContain("...(deskLight(kind, routed, { given: !!given,")
    expect(deskLight('keep', '내 생일은 3월 2일이야. 기억해', {})).toBe(true)
    expect(core('agent-session.ts')).toContain("...(options.lookup || options.light ? { effort: 'low' as const } : {}),")
  })
})

describe('small talk never sounds like a help desk (Q1)', () => {
  it('drops the help-desk sentence in any wording and keeps the rest', () => {
    for (const [said, left] of [
      ['안녕하세요! 뭘 도와드릴까요.', '안녕하세요!'], ['안녕하세요! 오늘은 무엇을 도와드릴까요?', '안녕하세요!'], ['좋은 아침이에요. 뭐 도와드릴까요?', '좋은 아침이에요.'],
      ['안녕하세요! 도와드릴 일 있으면 말씀하세요.', '안녕하세요!'], ['반가워요. 필요하신 게 있으면 말씀해 주세요.', '반가워요.'], ['Hi there! How can I help you today?', 'Hi there!'],
    ] as const) { expect(withoutHelpDesk(said), said).toBe(left); expect(cleanLine(said), said).toBe(left) }
    // Nothing but the help-desk sentence: no line at all (the small-talk path then says a plain greeting: model-tiers.test.ts).
    expect(cleanLine('무엇을 도와드릴까요?')).toBeUndefined()
  })
  it('leaves a colleague\'s line as it is', () => {
    for (const said of ['안녕하세요! 좋은 아침이에요.', '별말씀을요. 더 필요한 거 있으면 말씀하세요.', '회의록부터 읽어볼게요.', '거의 다 찾았어요, 금방 올릴게요.']) { expect(withoutHelpDesk(said), said).toBe(said); expect(cleanLine(said), said).toBe(said) }
    expect(withoutHelpDesk('안녕하세요!\n\n좋은 하루 보내세요.')).toBe('안녕하세요!\n\n좋은 하루 보내세요.')
  })
  it('describes the pattern in the prompts, not one string, and filters the main model\'s small talk too', () => {
    for (const text of [smallTalkPrompt('안녕', true), SMALL_TALK_NOTE, COLLEAGUE_RULE]) { expect(text).toMatch(/help in any wording/); expect(text).toContain('뭘 도와드릴까요') }
    expect(smallTalkPrompt('안녕', true)).toContain('안녕하세요! 좋은 아침이에요.')
    expect(source('ipc.ts')).toContain('if (plainAsk && plainReply(request.message) && !result.asked) result.answer = talkOnly(request.message, result.answer, threadKorean(request.message, request.history ?? []))')
    // r2: the main model's reply was only the help-desk question and `|| result.answer` put it back. The host's plain line is said instead.
    for (const said of ['뭘 도와드릴까요?', '무엇을 도와드릴까요?', '도움이 필요하시면 말씀해 주세요.']) {
      expect(talkOnly('안녕', said, true), said).toBe('안녕하세요!')
      expect(talkOnly('고마워 수고했어', said, true), said).toBe('별말씀을요.')
    }
    expect(talkOnly('hi', 'How can I help you today?', false)).toBe('Hi!')
    expect(talkOnly('안녕', '안녕하세요! 뭘 도와드릴까요?', true)).toBe('안녕하세요!')
    expect(talkOnly('안녕', '안녕하세요! 좋은 아침이에요.', true)).toBe('안녕하세요! 좋은 아침이에요.')
    expect(talkOnly('안녕', '', true)).toBe('')
  })
})

describe('a line in another language is led by a few Korean words (Q3)', () => {
  const ask = '"회의 늦어서 죄송합니다"를 정중한 영어 이메일 한 줄로 써줘', line = 'I apologize for being late to the meeting.'
  it('puts the lead on the same line when the answer has no Hangul', () => {
    expect(koreanLead(ask, line)).toBe(`이렇게 쓰면 돼요. ${line}`)
    expect(koreanLead(ask, `${line}\n\n\`\`\`replies\n더 짧게\n\`\`\``)).toBe(`이렇게 쓰면 돼요. ${line}\n\n\`\`\`replies\n더 짧게\n\`\`\``)
    expect(koreanLead('이걸 영어 메일로 써줘', 'Hi Minho,\n\nSorry for the delay.')).toBe('이렇게 쓰면 돼요.\n\nHi Minho,\n\nSorry for the delay.')
  })
  it('opens a rewording differently, and never twice the same way in a row', () => {
    expect(koreanLead('더 짧게', 'I apologize for being late.', `이렇게 쓰면 돼요. ${line}`)).toBe('이건 어때요? I apologize for being late.')
    expect(koreanLead('더 정중하게', 'My sincere apologies for the delay.', '이건 어때요? I apologize for being late.')).toBe('이렇게 쓰면 돼요. My sincere apologies for the delay.')
    expect(koreanLead(ask, line, `이렇게 쓰면 돼요. ${line}`)).toBe(`이건 어때요? ${line}`)
    // stack-5 (c5c run, Q4): the model wrote the same lead itself; its own lead is swapped too, and left alone when the reply before opened otherwise.
    expect(koreanLead('방금 말한 거 더 짧게', '이렇게 쓰면 돼요. I apologize for being late.', `이렇게 쓰면 돼요. ${line}`)).toBe('이건 어때요? I apologize for being late.')
    expect(koreanLead('방금 말한 거 더 짧게', '이건 어때요? I apologize for being late.', `이렇게 쓰면 돼요. ${line}`)).toBe('이건 어때요? I apologize for being late.')
  })
  it('adds nothing when the answer has Korean, has no words, or the person wrote in English', () => {
    for (const [said, answer] of [[ask, `이렇게 쓰면 돼요. ${line}`], [ask, '정중하게는 "I apologize"가 좋아요.'], ['Write a one-line apology email', line], ['1년은 몇 초야 숫자만 알려줘', '31,536,000'], [ask, '']] as const) expect(koreanLead(said, answer), said).toBe(answer)
    expect(source('ipc.ts')).toContain("if (kind === 'ask' && !result.asked) result.answer = koreanLead(request.message, result.answer, lastReplyOf(savedHistory.filter(one => !one.progress && !one.error)))")
  })
})

// stack-5 (c5c run, D3 64.3 s of 60): the first ppt_build was refused for "내용 입력" blanks (deck-audit.ts) and the deck was written twice.
describe('a marked blank is one the deck check lets through (D3)', () => {
  it('names the wording that passes, and the check agrees', async () => {
    const { auditDeck } = await import('../../../packages/core/src/deck-audit.js')
    expect(DESK_NOTE).toContain('A blank is those plain words in a cell or after its label ("매출: 수치 입력"), never in square brackets and never "내용 입력", "TBD" or the like')
    expect(auditDeck([{ title: '3분기 핵심 지표', bullets: ['매출: 수치 입력', '영업이익: 수치 입력'] }])).toEqual([])
    for (const blank of ['주요 성과: 내용 입력', '[수치 입력]']) expect(auditDeck([{ title: '3분기 핵심 지표', bullets: [blank] }]), blank).toHaveLength(1)
  })
})

describe('a follow-up names what it points at (H1)', () => {
  it('asks for the thing to be named, and for a reaction rather than a promise to keep track', () => {
    expect(SHORT_QUESTION_NOTE).toContain('When the ask points back at something said earlier ("그 여행", "거기", "그거", "아까 그"), the answer opens with one sentence that names it in the conversation\'s own words')
    expect(SHORT_QUESTION_NOTE).toContain('you never ask which one they mean')
    const told = toldPrompt('다음 주 목요일에 부모님 모시고 제주도 가. 아빠가 무릎이 안 좋으셔서 많이 걷는 건 힘들어', true)
    expect(told).toContain('Never a promise to keep track of it or bear it in mind ("챙겨 둘게요", "기억해 둘게요", "참고할게요")')
    expect(told).not.toMatch(/쪽으로 챙겨 둘게요|will keep it in mind/)
    expect(TOLD_NOTE).toContain('without saying that you will')
  })
})

describe('an extraction ends with one short offer, once per thread (H4)', () => {
  const ask = 'fixtures/meeting-notes.md 회의록에서 할 일만 뽑아줘'
  const answer = '할 일만 뽑았어요.\n\n- 한서연: 온보딩 화면 시안 확정 (11월 20일)\n- 오태민: 결제 모듈 교체 일정 수립 (11월 24일)'
  it('adds one line of at most 60 characters when the answer has none', () => {
    const out = withOffer(ask, answer, [], true)
    expect(out).toBe(`${answer}\n\n원하시면 담당자별로 보낼 알림 문구도 써 드릴게요.`)
    expect([...out.split('\n').at(-1)!].length).toBeLessThanOrEqual(60)
    // Once: the result is left alone.
    expect(withOffer(ask, out, [], true)).toBe(out)
    // c8c: an offer is the next step, never the same lines in another shape: nothing follows bare figures, dated lines get a timeline.
    expect(withOffer('notes.md에서 숫자만 추려줘', '- 38%\n- 12명', [], true)).toBe('- 38%\n- 12명')
    expect(withOffer('notes.md에서 마감만 추려줘', '- 시안 확정: 11월 20일\n- 공지 발송: 11/27', [], true)).toMatch(/\n\n원하시면 기한 순으로 일정표도 만들어 드릴게요\.$/)
    expect(withOffer(ask, '| 담당 | 할 일 |\n|---|---|\n| 한서연 | 시안 확정 |', [], true)).toMatch(/\n\n원하시면 담당자별로 보낼 알림 문구도 써 드릴게요\.$/)
    expect(withOffer('Extract the action items from notes.md', '- Seoyeon: finalize the screen', [], false)).toMatch(/\n\nI can draft a reminder for each owner if you'd like\.$/)
    // Above the reply suggestions, not under them.
    expect(withOffer(ask, `${answer}\n\n\`\`\`replies\n표로\n\`\`\``, [], true)).toBe(`${answer}\n\n원하시면 담당자별로 보낼 알림 문구도 써 드릴게요.\n\n\`\`\`replies\n표로\n\`\`\``)
  })
  it('adds nothing when the answer already offers, or an earlier reply in the thread did', () => {
    for (const closing of ['원하시면 담당자별로도 나눠 드릴게요.', '표로도 정리해 드릴까요?']) expect(withOffer(ask, `${answer}\n\n${closing}`, [], true)).toBe(`${answer}\n\n${closing}`)
    expect(withOffer(ask, answer, [{ role: 'user', text: '회의록 요약해줘' }, { role: 'assistant', text: '요약했어요.\n\n원하시면 워드 파일로도 만들어 드릴게요.' }], true)).toBe(answer)
    // A first line, a kept fact's reply or the person's own words are not an earlier offer.
    expect(withOffer(ask, answer, [{ role: 'assistant', text: '회의록부터 읽어볼게요.\n\n', progress: true }, { role: 'assistant', text: '기억해 둘게요.' }, { role: 'user', text: '원하시면 말해요' }], true)).not.toBe(answer)
  })
  it('never adds one to another kind of turn', () => {
    for (const other of ['엔비디아 오늘 주가 알려줘', '1년은 몇 초야?', '안녕', '고마워 수고했어', 'fixtures/meeting-notes.md 회의록 요약해서 결정사항이랑 할 일 정리해줘', 'fixtures/sales.csv에서 12월 매출 합계 알려줘',
      '지민, 서연, 도윤한테 나눠서 시켜', '할 일 세 개만 골라줘', 'fixtures/meeting-notes.md에서 할 일 뽑아서 워드로 만들어줘']) expect(withOffer(other, answer, [], true), other).toBe(answer)
    expect(withOffer(ask, '', [], true)).toBe('')
    expect(source('ipc.ts')).toContain("if (kind === 'note' && !result.asked) result.answer = withOffer(routed, result.answer, savedHistory, threadKorean(request.message, request.history ?? []))")
  })
})

describe('a note the host read is answered without long thinking (D1)', () => {
  it('keeps decisions and to-dos apart when the notes\' decisions are all tasks', () => {
    for (const part of ['When the decisions in the notes are all tasks with an owner and a date, 결정사항 says briefly what was agreed', '할 일 gives each owner and date', 'Every decision, owner and due date of the file is still in the answer'])
      expect(DESK_NOTE, part).toContain(part)
  })
})
