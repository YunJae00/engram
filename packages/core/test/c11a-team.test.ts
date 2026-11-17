import { expect, test } from 'vitest'
import { createBot, updateBot } from '../src/bots.js'
import { checkedReport, employeeNote, handoffBrief, mergedReport, reportData, reportPrompt, WRITER_RULE, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { dataText, settleMember, sourceName } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// c11a: teammates hand back data; one writer pass writes the message; the host checks only structure. Wordings here are not the harness's.
const NOW = new Date('2026-11-18T03:00:00Z')
const at = new Date(NOW.getTime() - 5_000).toISOString()
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
const member = (over: Partial<TeamMember> & Pick<TeamMember, 'id' | 'role' | 'brief'>): TeamMember => ({ parentId: null, depth: 1, botId: `bot-${over.id}`, lookup: true, background: true, state: 'hired', sessionKey: `s-${over.id}`, hiredAt: at, ...over })
// The teammate's answer goes through the same settle the runner uses, with the report parsed by reportData.
const settled = (m: TeamMember, answer: string, sources: string[] = []): TeamMember => {
  settleMember(m, { answer, sources, report: reportData(answer, m, sources, true) ?? null }, NOW.toISOString(), true)
  return m
}
const links = (text: string): string[] => [...text.matchAll(/\[([^\]]+)\]\((https?:[^)]+)\)/g)].map(one => one[1]!)

function messengers(): TeamMember[] {
  const kakao = settled(member({ id: 'm1', role: '민준', brief: '이번 달 카카오톡 업데이트 조사', topic: '카카오톡' }), block({ facts: [{ text: '카카오톡에 채팅방 폴더 정리 기능이 생겼어요.', url: 'https://www.kakaocorp.com/page/detail/11234', site: '카카오', date: '11월 6일' }], note: '폴더 기능 꽤 쓸만해 보여요.' }))
  const line = settled(member({ id: 'm2', role: '지아', brief: '이번 달 라인 업데이트 조사', topic: '라인' }), block({ facts: [], nothing_in_period: { latest: { text: '라인 앨범 화질 개선이 마지막 업데이트예요.', url: 'https://linecorp.com/ko/pr/news/ko/2026/5012', site: '출처', date: '10월 21일' } } }))
  const tele = settled(member({ id: 'm3', role: '하율', brief: '이번 달 텔레그램 업데이트 조사', topic: '텔레그램' }), block({ facts: [{ text: '텔레그램이 그룹 통화 인원을 늘렸어요.', url: 'https://telegram.org/blog/group-calls-2026', site: 'telegram', date: '11월 3일' }] }))
  return [kakao, line, tele]
}
const ASK = '카카오톡, 라인, 텔레그램 이번 달 업데이트 나눠서 알아봐. 민준, 지아, 하율한테 나눠서 시켜'

test('a split research ask: each part is data, site names come from the host, and a good writer message passes the structure check', () => {
  const parts = messengers()
  expect(parts.map(m => m.state)).toEqual(['done', 'done', 'done'])
  expect(parts[1]!.empty).toBe(true)
  // Never the plain word "출처", never a piece of the host as a name: the host's own naming, else the host.
  expect(parts.flatMap(m => [...m.data!.facts, ...(m.data!.nothing?.latest ? [m.data!.nothing.latest] : [])]).map(f => f.site)).toEqual(['카카오', 'linecorp.com', 'telegram.org'])
  const prompt = reportPrompt(ASK, parts, new Map(), { now: NOW })
  expect(prompt).not.toMatch(/더라고요|네요|in every sentence|exactly their name and a colon/)
  const message = '이번 달엔 카카오톡이랑 텔레그램에 새 기능이 나왔어요. 카카오톡은 민준이 봤는데 11월 6일에 채팅방 폴더 정리 기능이 생겼어요. [카카오](https://www.kakaocorp.com/page/detail/11234) 라인은 지아가 봤는데 이번 달엔 새 소식이 없고, 10월 21일 앨범 화질 개선이 제일 최근이에요. [linecorp.com](https://linecorp.com/ko/pr/news/ko/2026/5012) 텔레그램은 하율이 확인했는데 11월 3일에 그룹 통화 인원이 늘었어요. [telegram.org](https://telegram.org/blog/group-calls-2026)'
  const shown = checkedReport(JSON.stringify({ message, kept: ['f1', 'f2'] }), parts)!
  expect(shown).toBeDefined()
  for (const name of ['민준', '지아', '하율']) expect(shown).toContain(name)
  expect(shown).not.toMatch(/^\s*(?:민준|지아|하율)\s*:/m)
  expect(links(shown)).toEqual(['카카오', 'linecorp.com', 'telegram.org'])
  expect(links(shown)).not.toContain('출처')
})

test('the structure check refuses a name-and-colon stack, a missing teammate, a dropped part link and an address not in the data', () => {
  const parts = messengers()
  const ok = (message: string, kept = ['f1', 'f2']): string | undefined => checkedReport(JSON.stringify({ message, kept }), parts)
  const k = '[카카오](https://www.kakaocorp.com/page/detail/11234)', l = '[라인](https://linecorp.com/ko/pr/news/ko/2026/5012)', t = '[텔레그램](https://telegram.org/blog/group-calls-2026)'
  expect(ok(`정리했어요.\n\n민준: 폴더 기능이 생겼어요. ${k}\n\n지아: 라인은 새 소식이 없어요. ${l}\n\n하율: 통화 인원이 늘었어요. ${t}`)).toBeUndefined()
  expect(ok(`카카오톡은 민준이 봤어요. ${k} 라인은 지아가 봤는데 새 소식이 없어요. ${l} 텔레그램은 통화 인원이 늘었어요. ${t}`)).toBeUndefined()
  expect(ok(`카카오톡은 민준이 봤어요. ${k} 라인은 지아가 봤는데 새 소식이 없어요. 텔레그램은 하율이 봤어요. ${t}`)).toBeUndefined()
  expect(ok(`카카오톡은 민준이 봤어요. [블로그](https://blog.example.com/x) 라인은 지아가 봤는데 새 소식이 없어요. ${l} 텔레그램은 하율이 봤어요. ${t}`)).toBeUndefined()
  expect(ok('이건 JSON이 아니에요')).toBeUndefined()
})

test('a handoff that makes copy: the shown list is exactly the writer\'s items, never their chat prose or a draft aside', async () => {
  const giver = settled(member({ id: 'm1', role: '민준', brief: '해운대 근처 부산 맛집 찾기', then: { botId: 'bot-m2', who: '지아', brief: '인스타 문구 2개 써' } }), block({ facts: [{ text: '해운대 시장 안 꼼장어 골목이 요즘 줄 서는 곳이에요.', url: 'https://www.visitbusan.net/food/123', site: '비짓부산' }] }))
  const brief = handoffBrief('인스타 문구 2개 써', '민준', giver.result!, giver.brief)
  // The next teammate reads the giver's shown facts with their page, not the rows they read.
  expect(brief).toContain('해운대 시장 안 꼼장어 골목이 요즘 줄 서는 곳이에요. — https://www.visitbusan.net/food/123')
  const raw = '좋아요, 써 볼게요! 😏 아니 이건 빼고 — 첫 줄은 이렇게 하더라고요!\n' + block({ items: ['1. 해운대 시장 꼼장어 골목, 줄 서도 아깝지 않은 한 끼 🔥', '바닷바람 맞고 꼼장어 한 접시, 이게 부산이지'], note: '꼼장어 쪽으로 잡아 봤어요.' })
  const copy = settled(member({ id: 'm2', role: '지아', brief, lookup: undefined, writer: true }), raw)
  expect(copy.data!.items).toEqual(['해운대 시장 꼼장어 골목, 줄 서도 아깝지 않은 한 끼 🔥', '바닷바람 맞고 꼼장어 한 접시, 이게 부산이지'])
  expect(dataText(copy.data!)).not.toMatch(/아니 이건 빼고|더라고요/)
  const shown = mergedReport([giver, copy])
  expect(shown.match(/^\d+\. /gm)).toHaveLength(2)
  expect(shown).not.toMatch(/아니 이건 빼고|더라고요|써 볼게요/)
  expect(shown).toContain('지아')
  // A writer message that changes an item is refused, and the host's plain rendering stands.
  const bent = JSON.stringify({ message: '지아가 민준이 찾은 꼼장어 골목으로 두 개 썼어요.\n\n1. 해운대 시장 꼼장어 골목, 줄 서도 아깝지 않은 한 끼 🔥 아니 이건 빼고\n2. 바닷바람 맞고 꼼장어 한 접시, 이게 부산이지', kept: [] })
  expect(await writtenReport({ ask: '민준이 찾은 부산 맛집으로 지아가 인스타 문구 2개 써', members: [giver, copy], write: async () => bent, timeoutMs: 500, now: NOW })).toBe(shown)
})

test('a list job: a search-page-only item never reaches the writer, and the writer drops a wrong-kind item by meaning; links follow kept', async () => {
  const meetups = settled(member({ id: 'm1', role: '하율', brief: '다음 달 판교 개발자 밋업 일정 정리', topic: '판교 밋업' }), block({ facts: [
    { text: '판교 쿠버네티스 밋업이 열려요.', url: 'https://festa.io/events/5521', site: '페스타', date: '12월 4일' },
    { text: '판교 스탠드업 코미디 쇼가 있어요.', url: 'https://ticket.example.com/show/88', site: '티켓', date: '12월 6일' },
    { text: '프런트엔드 개발자 모임이 있어요.', url: 'https://search.naver.com/search.naver?query=%ED%8C%90%EA%B5%90', site: '네이버', date: '12월 11일' },
    { text: '판교 AI 엔지니어 밋업이 열려요.', url: 'https://www.meetup.com/pangyo-ai/events/77', site: 'Meetup', date: '12월 15일' },
  ] }))
  const prompt = reportPrompt('다음 달 판교 개발자 밋업 일정 알려줘', [meetups], new Map(), { now: NOW })
  expect(prompt).not.toContain('search.naver.com')
  expect(prompt).not.toMatch(/공연|콘서트|IT 행사/)
  const message = '다음 달 판교 개발자 밋업은 두 개예요. 하율이 찾아 줬어요.\n\n- 12월 4일 판교 쿠버네티스 밋업 [페스타](https://festa.io/events/5521)\n- 12월 15일 판교 AI 엔지니어 밋업 [Meetup](https://www.meetup.com/pangyo-ai/events/77)'
  const shown = await writtenReport({ ask: '다음 달 판교 개발자 밋업 일정 알려줘', members: [meetups], write: async () => JSON.stringify({ message, kept: ['f1', 'f3'] }), timeoutMs: 500, now: NOW })
  expect(shown).not.toMatch(/코미디|프런트엔드/)
  expect(links(shown)).toHaveLength(2)
  // Kept says the comedy show stays, but the message leaves its link out: refused (the count follows kept, not the prose).
  expect(checkedReport(JSON.stringify({ message, kept: ['f1', 'f2', 'f3'] }), [meetups])).toBeUndefined()
})

test('a compare job: a table is fine, and every link is named by the site or its host, never 출처', () => {
  const a = settled(member({ id: 'm1', role: '민준', brief: '모토로라 엣지 70 가격이랑 출시일', topic: '엣지 70' }), block({ facts: [{ text: '가격은 699달러예요.', url: 'https://www.motorola.com/us/edge-70', site: '출처' }, { text: '출시일은 10월 2일이에요.', url: 'https://www.gsmarena.com/motorola_edge_70-1.php', site: 'GSMArena' }] }))
  const b = settled(member({ id: 'm2', role: '지아', brief: '낫싱 폰 4 가격이랑 출시일', topic: '낫싱 폰 4' }), block({ facts: [{ text: '가격은 649달러예요.', url: 'https://nothing.tech/products/phone-4', site: 'nothing' }] }))
  expect([...a.data!.facts, ...b.data!.facts].map(f => f.site)).toEqual(['motorola.com', 'gsmarena.com', 'nothing.tech'])
  const message = '엣지 70이 50달러 더 비싸요. 민준이랑 지아가 나눠 봤어요.\n\n| 제품 | 가격 | 출시일 |\n|---|---|---|\n| 엣지 70 | 699달러 [motorola.com](https://www.motorola.com/us/edge-70) | 10월 2일 [gsmarena.com](https://www.gsmarena.com/motorola_edge_70-1.php) |\n| 낫싱 폰 4 | 649달러 [nothing.tech](https://nothing.tech/products/phone-4) | 미정 |'
  const shown = checkedReport(JSON.stringify({ message: message.replace('[motorola.com]', '[출처]'), kept: ['f1', 'f2', 'f3'] }), [a, b])!
  expect(shown).toContain('| 엣지 70 |')
  expect(links(shown)).toEqual(['motorola.com', 'gsmarena.com', 'nothing.tech'])
  expect(sourceName('https://unknown-review-site.example/post/1', true)).toBe('unknown-review-site.example')
})

test('fallback: a writer that misses its time leaves a neutral rendering, still attributed and linked', async () => {
  const parts = messengers()
  const shown = await writtenReport({ ask: ASK, members: parts, write: () => new Promise(() => undefined), timeoutMs: 30, now: NOW })
  expect(shown).toBe(mergedReport(parts))
  for (const name of ['민준', '지아', '하율']) expect(shown).toContain(name)
  expect(links(shown)).toEqual(['카카오', 'linecorp.com', 'telegram.org'])
  expect(shown).not.toMatch(/더라고요|네요[.!]|출처/)
  // A part still at work is labeled (GROKBOT rule 7), and one that gave no report is labeled, its prose never parsed into items.
  const loose = member({ id: 'm4', role: '도윤', brief: '이번 달 왓츠앱 업데이트 조사', topic: '왓츠앱' })
  settled(loose, '왓츠앱은 11월 9일에 채널 기능이 나왔더라고요! https://blog.whatsapp.com/x')
  expect(loose.data).toBeUndefined()
  const still = member({ id: 'm5', role: '서아', brief: '이번 달 시그널 업데이트 조사', topic: '시그널', state: 'working' })
  const two = mergedReport([...parts, loose, still])
  expect(two).toContain('왓츠앱(도윤): 이번엔 못 찾았어요.')
  expect(two).not.toContain('blog.whatsapp.com')
  expect(two).toContain('시그널(서아): 아직 찾는 중이에요. 끝나면 이어서 올릴게요.')
})

test('persona: a temperament with no fixed ending, never "in every sentence", and none in a writer\'s deliverable prompt', async () => {
  const paths = await initVault(await tmpVaultRoot('c11a-team'), { git: false })
  await createBot(paths, { name: '엔그램' })
  const bot = await createBot(paths, { name: '지아', purpose: '글 담당' })
  await updateBot(paths, bot.id, { label: '글 담당' })
  const lookup = await employeeNote(paths, bot.id, NOW, 'lookup'), writer = await employeeNote(paths, bot.id, NOW, 'writer')
  for (const note of [lookup, writer, WRITER_RULE]) {
    expect(note).not.toMatch(/in every sentence|더라고요|…네요|확인해 보니/)
  }
  expect(lookup).toMatch(/temperament/)
  expect(lookup).toContain('```report')
  expect(writer).not.toMatch(/temperament/)
  expect(WRITER_RULE).toContain('"items"')
})

test('reportData: prose with no block is no data; a writer\'s items are cut to the count asked', () => {
  expect(reportData('라인은 새 소식이 없더라고요.', { brief: '라인 업데이트 조사' })).toBeUndefined()
  expect(reportData(block({ facts: [{ text: '숫자', url: 'not a url' }] }), { brief: 'x' })).toBeUndefined()
  expect(reportData(block({ facts: [{ text: '숫자 하나', url: 'nope' }] }), { brief: 'x' }, ['https://a.example/p'])!.facts[0]!.url).toBe('https://a.example/p')
  expect(reportData(block({ items: ['하나', '둘', '셋'] }), { brief: '문구 2개 써', writer: true })!.items).toEqual(['하나', '둘'])
})
