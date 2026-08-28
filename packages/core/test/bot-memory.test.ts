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
  MEMORY_CHARS,
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
    expect(change).toEqual({ added: 2, touched: 0 })
    await stat(join(paths.cache, 'bot-memory', 'b1.json'))
    const file = await loadBotMemory(paths, 'b1')
    expect(file.facts.map((f) => f.text)).toEqual(['Sits on the 4th floor', 'Prefers short answers'])
    expect(file.turns).toBe(1)
  })

  it('a fact said again is one fact with a fresh clock', async () => {
    const paths = await tempPaths()
    await recordFacts(paths, 'b1', ['Prefers short answers.'], T1)
    const change = await recordFacts(paths, 'b1', ['prefers  short answers'], T2)
    expect(change).toEqual({ added: 0, touched: 1 })
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
    expect(chosen.reduce((n, f) => n + f.text.length, 0)).toBeLessThanOrEqual(MEMORY_CHARS)
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
    expect(prompt.length).toBeLessThan(1_200)
  })
})
