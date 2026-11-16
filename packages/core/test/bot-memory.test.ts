import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  factScore,
  forgetBotMemory,
  forgetFact,
  loadBotMemory,
  memorableTurn,
  MEMORY_BUDGET,
  parseFactLines,
  recordFacts,
  rememberPrompt,
  renderMemory,
  selectForPrompt,
  type BotMemoryFile,
} from '../src/bot-memory.js'
import type { VaultPaths } from '../src/vault.js'

async function tempPaths(): Promise<VaultPaths> {
  const root = await mkdtemp(join(tmpdir(), 'engram-memory-'))
  return { root, workspace: root, cache: join(root, '.engram') } as unknown as VaultPaths
}

const T1 = new Date('2026-08-01T09:00:00Z')
const T2 = new Date('2026-08-20T09:00:00Z')

describe('memorableTurn', () => {
  it('skips greetings, acks, pointers and unanswered turns', () => {
    expect(memorableTurn('고마워!', 'x')).toBe(false)
    expect(memorableTurn('ok', 'x')).toBe(false)
    expect(memorableTurn('그거 처리해줘', '무엇을?')).toBe(false)
    expect(memorableTurn('내 자리는 4층 창가야', '')).toBe(false)
  })
  it('keeps a turn that says something', () => {
    expect(memorableTurn('내 자리는 4층 창가야', '알겠습니다')).toBe(true)
    expect(memorableTurn('What is our deploy procedure?', 'Thursday afternoons.')).toBe(true)
  })
  it('qa145: a value handed over only to be written back is not kept, a told fact is', () => {
    expect(memorableTurn('프로젝트 코드명은 TeStCode 야. 이 코드명을 대소문자 그대로 한 줄로만 다시 적어 줘.', 'TeStCode')).toBe(false)
    expect(memorableTurn('스프린트 마감은 11월 20일이야. 그 문장 그대로 한 줄로만 다시 적어 줘.', '스프린트 마감은 11월 20일이야.')).toBe(false)
    expect(memorableTurn('기억해 줘. 우리 팀 코드명은 은하수이고, 다음 스프린트 마감은 11월 25일이야. 이 두 가지만 기억하고, 파일은 만들지 마.', '기억했어요')).toBe(true)
    expect(memorableTurn('우리 팀 코드명은 은하수야. 기억하고 다시 적어 줘.', '은하수')).toBe(true)
  })
})

describe('parseFactLines', () => {
  it('keeps facts, drops NONE, restatements and secrets', () => {
    const raw = '- Sits on the 4th floor by the window.\n- sits on the 4th floor by the window\nNONE\n- Password is hunter2\n- Meetings only on Thursday afternoons.'
    expect(parseFactLines(raw, [])).toEqual(['Sits on the 4th floor by the window', 'Meetings only on Thursday afternoons'])
    expect(parseFactLines('- Sits on the 4th floor by the window.', ['Sits on the 4th floor by the window'])).toEqual([])
    expect(parseFactLines('NONE', [])).toEqual([])
  })
})

describe('recordFacts', () => {
  it('lands under the cache folder and comes back after a fresh load', async () => {
    const paths = await tempPaths()
    const change = await recordFacts(paths, 'b1', ['Sits on the 4th floor', 'Prefers short answers'], T1)
    expect(change).toEqual({ added: 2, touched: 0, replaced: [] })
    await stat(join(paths.cache, 'bot-memory', 'b1.json'))
    const file = await loadBotMemory(paths, 'b1')
    expect(file.facts.map((f) => f.text)).toEqual(['Sits on the 4th floor', 'Prefers short answers'])
    expect(file.turns).toBe(1)
  })

  it('a fact said again is one fact with a fresh clock', async () => {
    const paths = await tempPaths()
    await recordFacts(paths, 'b1', ['Prefers short answers.'], T1)
    const change = await recordFacts(paths, 'b1', ['prefers  short answers'], T2)
    expect(change).toEqual({ added: 0, touched: 1, replaced: [] })
    const [fact] = (await loadBotMemory(paths, 'b1')).facts
    expect(fact?.at).toBe(T1.toISOString())
    expect(fact?.touchedAt).toBe(T2.toISOString())
  })

  it('a fact can be forgotten one by one, or the whole memory at once', async () => {
    const paths = await tempPaths()
    await recordFacts(paths, 'b1', ['One', 'Two'], T1)
    const [one] = (await loadBotMemory(paths, 'b1')).facts
    await forgetFact(paths, 'b1', one!.id)
    expect((await loadBotMemory(paths, 'b1')).facts.map((f) => f.text)).toEqual(['Two'])
    await forgetBotMemory(paths, 'b1')
    await expect(readFile(join(paths.cache, 'bot-memory', 'b1.json'), 'utf8')).rejects.toBeTruthy()
  })
})

describe('ranking and rendering', () => {
  it('a fact fades by half a month after it was last said', () => {
    const fact = { id: 'f', text: 'x', at: T1.toISOString(), touchedAt: T1.toISOString() }
    expect(factScore(fact, T1)).toBe(1)
    expect(factScore(fact, new Date(T1.getTime() + 30 * 86_400_000))).toBeCloseTo(0.5, 5)
  })

  it('renders the freshest within the budget, in the order first written', () => {
    const facts = Array.from({ length: 30 }, (_, i) => ({
      id: `f${i}`,
      text: `fact number ${i} ${'x'.repeat(60)}`,
      at: new Date(T1.getTime() + i * 60_000).toISOString(),
      touchedAt: new Date(T1.getTime() + (i % 2 ? 25 : 0) * 86_400_000).toISOString(),
    }))
    const file: BotMemoryFile = { facts, turns: 30 }
    const chosen = selectForPrompt(file, T2)
    expect(chosen.reduce((n, f) => n + f.text.length, 0)).toBeLessThanOrEqual(MEMORY_BUDGET.shared.chars)
    expect(chosen.every((f) => f.touchedAt !== T1.toISOString())).toBe(true)
    expect(chosen.map((f) => f.at)).toEqual([...chosen.map((f) => f.at)].sort())
    expect(renderMemory(file, T2)).toMatch(/^- \(2026-08-01\) fact number 1 /)
    expect(renderMemory({ facts: [], turns: 0 })).toBe('')
  })

  it('the prompt carries the kept facts and the exchange, nothing more', () => {
    const prompt = rememberPrompt({ user: '내 자리는 4층이야', answer: '알겠습니다' }, ['Prefers short answers'])
    expect(prompt).toContain('JOB: COMET-REMEMBER')
    expect(prompt).toContain('- Prefers short answers')
    expect(prompt).toContain('Person: 내 자리는 4층이야')
    expect(prompt.length).toBeLessThan(1_800)
  })
  it('qa145: suggested replies never reach the extractor', () => {
    const prompt = rememberPrompt({ user: '우리 팀 코드명은 은하수야', answer: '기억했어요.\n\n```replies\n고마워\n코드명도 문서에 넣어줘\n```', previous: '정리했어요.\n\n```replies\n스프린트 마감 바뀌면 알려줄게\n```' }, [])
    expect(prompt).toContain('You answered: 기억했어요.')
    expect(prompt).not.toContain('코드명도 문서에 넣어줘')
    expect(prompt).not.toContain('스프린트 마감 바뀌면 알려줄게')
    expect(prompt).toContain('- outdated: ')
  })
  it('qa145: a later value replaces the older one, and junk already on disk is not read back', async () => {
    const paths = await tempPaths()
    await recordFacts(paths, 'bot-q', ['다음 스프린트 마감은 11월 20일이다', '팀 코드명은 은하수다'], T1)
    const change = await recordFacts(paths, 'bot-q', ['다음 스프린트 마감은 11월 25일이다'], T2)
    expect(change.replaced).toEqual(['다음 스프린트 마감은 11월 20일이다'])
    expect((await loadBotMemory(paths, 'bot-q')).facts.map((f) => f.text)).toEqual(['팀 코드명은 은하수다', '다음 스프린트 마감은 11월 25일이다'])
    await recordFacts(paths, 'bot-q', ['# 도구를 사용하겠습니다', '<execute>', '| 사과 | 1000 |', '## COMET-REMEMBER'], T2)
    expect((await loadBotMemory(paths, 'bot-q')).facts.map((f) => f.text)).toEqual(['팀 코드명은 은하수다', '다음 스프린트 마감은 11월 25일이다'])
  })
  it('qa145 r2: two events with different dates both stay', async () => {
    const paths = await tempPaths()
    await recordFacts(paths, 'bot-e', ['행사 일정은 11월 20일이다'], T1)
    const later = await recordFacts(paths, 'bot-e', ['행사 일정은 12월 4일이다'], T2)
    expect(later.replaced).toEqual([])
    // Said together, even a long shared subject is two facts.
    const together = await recordFacts(paths, 'bot-e', ['다음 분기 고객 방문은 1월 8일이다', '다음 분기 고객 방문은 2월 3일이다'], T2)
    expect(together.replaced).toEqual([])
    expect((await loadBotMemory(paths, 'bot-e')).facts.map((f) => f.text)).toEqual(['행사 일정은 11월 20일이다', '행사 일정은 12월 4일이다', '다음 분기 고객 방문은 1월 8일이다', '다음 분기 고객 방문은 2월 3일이다'])
  })
  it('qa145 r2: a promise already on disk is not read back', async () => {
    const paths = await tempPaths()
    await recordFacts(paths, 'bot-p', ['스프린트 마감 바뀌면 알려줄게', '팀 코드명은 은하수다'], T1)
    expect((await loadBotMemory(paths, 'bot-p')).facts.map((f) => f.text)).toEqual(['팀 코드명은 은하수다'])
  })
})

describe('the profile every comet shares', () => {
  it('merges shared and own facts once each, keeping the fresher clock, and forgets by text in both', async () => {
    const { mergeMemory, forgetFactText, PERSON_MEMORY } = await import('../src/bot-memory.js')
    const paths = await tempPaths()
    await recordFacts(paths, PERSON_MEMORY, ['Prefers totals in USD', 'Works in the finance team'], T1)
    await recordFacts(paths, 'bot-a', ['Prefers totals in USD.', 'Reviews invoices on Mondays'], T2)
    const merged = mergeMemory(await loadBotMemory(paths, PERSON_MEMORY), await loadBotMemory(paths, 'bot-a'))
    expect(merged.facts.map((f) => f.text).sort()).toEqual(['Prefers totals in USD', 'Reviews invoices on Mondays', 'Works in the finance team'])
    expect(merged.facts.find((f) => f.text === 'Prefers totals in USD')!.touchedAt).toBe(T2.toISOString())
    await forgetFactText(paths, PERSON_MEMORY, 'prefers totals in usd')
    await forgetFactText(paths, 'bot-a', 'Prefers totals in USD')
    expect((await loadBotMemory(paths, PERSON_MEMORY)).facts.map((f) => f.text)).toEqual(['Works in the finance team'])
    expect((await loadBotMemory(paths, 'bot-a')).facts.map((f) => f.text)).toEqual(['Reviews invoices on Mondays'])
  })
  it('shows the previous answer so a correction can become a rule', () => {
    const prompt = rememberPrompt({ user: 'No, always round to whole euros', answer: 'Understood.', previous: 'The total is 1,234.56 EUR' }, [])
    expect(prompt).toContain('Your previous answer: The total is 1,234.56 EUR')
    expect(prompt).toContain('keep the rule they gave')
    expect(rememberPrompt({ user: 'Hi there, my team is Ops', answer: 'Noted.' }, [])).not.toContain('Your previous answer')
  })
})
