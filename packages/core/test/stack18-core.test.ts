import { afterEach, expect, test } from 'vitest'
import { handoffBrief, mergedReport, setReportLog, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { messageUnits, spliced, withoutSentences } from '../src/written-check.js'

// stack-18: the regressions the c18a/c18b full runs showed against stack17 (H5, C5), fixed at their cause. Wordings are in no harness row:
// 가람 looks up a 귤 축제, 다온 writes 소개 문구 from it.
const CHECK = 'Judge meaning only', REPAIR = 'You fix a message before a person reads it'
const part = (id: string, role: string, brief: string, rest: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role, brief, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: '', ...rest })
const PAGE = 'https://festival.example.kr/gyul'
const FACT = '12월 6일부터 서귀포 귤 축제가 열려요.'
const garam = part('m1', '가람', '서귀포 귤 축제 일정 알아봐', { background: true, result: FACT, then: { botId: 'bot-m2', who: '다온', brief: '그걸로 소개 문구 한 줄 써' }, data: { facts: [{ text: FACT, url: PAGE, site: '축제' }] } })
const daon = (rest: Partial<TeamMember>): TeamMember => part('m2', '다온', handoffBrief('그걸로 소개 문구 한 줄 써', '가람', `${FACT} — ${PAGE}`, '서귀포 귤 축제 일정 알아봐'), { lookup: undefined, writer: true, background: true, ...rest })
const ASK = '가람이는 서귀포 귤 축제 일정 알아보고, 다온이는 그걸로 소개 문구 한 줄 써줘'
const logged: string[] = []
afterEach(() => { logged.length = 0; setReportLog(() => undefined) })

test('H5 cause: the giver\'s report knows the rest of the ask is the receiver\'s, in the writer\'s and the check\'s data alike', async () => {
  const calls: string[] = []
  const quick = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? JSON.stringify({ problems: [] }) : JSON.stringify({ message: `서귀포 귤 축제는 12월 6일부터 열려요. 가람이 찾았어요. [축제](${PAGE})`, kept: ['f1'] }) }
  // The receiver is still writing: the giver's own bubble comes now (handoffShown).
  await writtenReport({ ask: ASK, members: [garam, daon({ state: 'working' })], write: quick, timeoutMs: 15_000 })
  const writer = calls.find(p => !p.includes(CHECK))!, check = calls.find(p => p.includes(CHECK))!
  for (const prompt of [writer, check]) expect(prompt).toContain('"handsOnTo":{"name":"다온","job":"그걸로 소개 문구 한 줄 써"}')
  expect(writer).toContain('never write their part or say it is done')
  expect(check).toContain('Nor need the job of a teammate a part hands its find on to ("handsOnTo")')
  // Once the receiver has its own result, the giver's part is not handed on any more: no such field.
  calls.length = 0
  await writtenReport({ ask: ASK, members: [garam, daon({ data: { facts: [], items: ['겨울 서귀포, 귤 향 가득한 축제로 오세요'] } })], write: quick, timeoutMs: 15_000 })
  expect(calls.join('\n')).not.toContain('"handsOnTo":{')
  expect(calls.find(p => !p.includes(CHECK))).not.toContain('never write their part')
})

test('C5 cause: the repair for a teammate left unnamed may change the sentence of their find, so the name goes there, not on a line of its own', async () => {
  setReportLog(line => logged.push(line))
  const calls: string[] = []
  const draft = `서귀포 귤 축제 일정이 나왔어요.\n\n${FACT} [축제](${PAGE})`
  const quick = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? JSON.stringify({ problems: [] }) : prompt.includes(REPAIR) ? JSON.stringify({ replace: { 2: `가람이 보니 ${FACT} [축제](${PAGE})` } }) : JSON.stringify({ message: draft, kept: ['f1'] }) }
  const out = await writtenReport({ ask: '이거 가람한테 맡겨: 서귀포 귤 축제 일정', members: [{ ...garam, then: undefined }], write: quick, timeoutMs: 15_000 })
  const repair = calls.find(p => p.includes(REPAIR))!
  // Before: "Only these units may be replaced: [] (none)", so the only fix was a new line.
  expect(repair).toContain('Only these units may be replaced: [2]')
  expect(repair).toContain('with no new line')
  expect(out).toBe(`서귀포 귤 축제 일정이 나왔어요.\n\n가람이 보니 ${FACT} [축제](${PAGE})`)
  expect(logged.join('\n')).toMatch(/writer=repaired:unnamed/)
})

test('H5: a writer that ended with nothing did not "find" nothing: its line says it did not get it written', () => {
  const out = mergedReport([daon({ state: 'done', unfinished: true })])
  expect(out).toBe('다온은 이번엔 다 못 썼어요.')
  expect(out).not.toContain('못 찾았어요')
  // A lookup part keeps its own line.
  expect(mergedReport([part('m3', '하람', '귤 가격 알아봐', { state: 'done', unfinished: true })])).toBe('하람은 이번엔 못 찾았어요.')
})

test('c18b D1 cause: a repair or a removal that empties a fenced block leaves no empty code box behind', () => {
  const draft = ['분기 워크숍 정리예요.', '', '정한 것', '- 장소는 강릉으로 해요.', '', '```', '원하시면 표로도 만들어 드릴까요?', '```'].join('\n')
  const units = messageUnits(draft), offer = units.findIndex(u => u.text.startsWith('원하시면'))
  const repaired = spliced(draft, JSON.stringify({ replace: { [String(offer + 1)]: '' } }), new Set([offer]))!
  expect(repaired).toBe('분기 워크숍 정리예요.\n\n정한 것\n- 장소는 강릉으로 해요.')
  expect(withoutSentences(draft, [{ kind: 'asks', quote: '원하시면 표로도 만들어 드릴까요?', why: '' }])).toBe('분기 워크숍 정리예요.\n\n정한 것\n- 장소는 강릉으로 해요.')
  // A block that still holds something stays.
  const code = '이렇게 쓰면 돼요.\n```\nSELECT 1\n```\n표로도 드릴까요?'
  expect(withoutSentences(code, [{ kind: 'asks', quote: '표로도 드릴까요?', why: '' }])).toBe('이렇게 쓰면 돼요.\n```\nSELECT 1\n```')
})
