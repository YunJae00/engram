import { describe, expect, it, vi } from 'vitest'
import { isIdentityFact, MEMORY_BUDGET, renderMemory, scopeFacts, selectForPrompt, type BotFact } from '../src/bot-memory.js'
import { keepInMindTool } from '../src/learning-tools.js'

const NOW = new Date('2026-11-10T00:00:00Z')
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const facts = (prefix: string, count: number, size: number): BotFact[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, text: `${prefix}${i} ${'x'.repeat(size)}`, at: day(count - i), touchedAt: day(i) }))

describe('scopeFacts', () => {
  it('routes marked lines, strips the marker and keeps a sentence marked both ways once, shared', () => {
    expect(scopeFacts('- Everyone: 결정: A\n- this bot: 결정: A', [])).toEqual({ shared: ['결정: A'], own: [] })
    expect(scopeFacts('* everyone: 보고서는 표로 받는 걸 좋아한다\n- THIS BOT: 사내 포털은 4층 담당이다', [])).toEqual({ shared: ['보고서는 표로 받는 걸 좋아한다'], own: ['사내 포털은 4층 담당이다'] })
    expect(scopeFacts('- everyone: 결정: A\n- this bot: 결정: B', ['결정: A'])).toEqual({ shared: [], own: ['결정: B'] })
  })

  it('falls back to Korean identity phrases for unmarked lines', () => {
    expect(isIdentityFact('선호하는 호칭은 윤재님')).toBe(true)
    expect(isIdentityFact('시간대는 서울이다')).toBe(true)
    expect(isIdentityFact('타임존은 KST')).toBe(true)
    expect(scopeFacts('- 이름은 윤재라고 불러 달라고 했다', [])).toEqual({ shared: ['이름은 윤재라고 불러 달라고 했다'], own: [] })
    expect(scopeFacts('- 사무실은 4층이다', [])).toEqual({ shared: [], own: ['사무실은 4층이다'] })
  })

  it('never keeps a secret in either scope', () => {
    expect(scopeFacts('- everyone: 회사 비밀번호는 Abc12345\n- this bot: token: abcdef123', [])).toEqual({ shared: [], own: [] })
  })
})

describe('keep_in_mind scope', () => {
  it('defaults to everyone and passes this bot through', async () => {
    const keep = vi.fn(async () => undefined)
    const tool = keepInMindTool({ keep })
    await tool.run({ facts: ['보고서는 표로 받는다'] }, { task: '' })
    expect(keep).toHaveBeenLastCalledWith(['보고서는 표로 받는다'], 'everyone')
    await tool.run({ facts: ['포털은 portal.example 이다'], scope: 'this bot' }, { task: '' })
    expect(keep).toHaveBeenLastCalledWith(['포털은 portal.example 이다'], 'this bot')
    await tool.run({ facts: ['다른 값'], scope: 'nobody' }, { task: '' })
    expect(keep).toHaveBeenLastCalledWith(['다른 값'], 'everyone')
    await expect(tool.run({ facts: ['Use the key sk-abcdefghijklmnopqrstuvwxyz123456'] }, { task: '' })).rejects.toThrow('key')
  })
})

describe('prompt budget per layer', () => {
  const split = (shared: BotFact[], own: BotFact[]) => {
    const chosen = selectForPrompt({ facts: [...shared, ...own], turns: 1, shared: shared.length }, NOW)
    const ids = new Set(shared.map((f) => f.id))
    return { all: chosen, shared: chosen.filter((f) => ids.has(f.id)), own: chosen.filter((f) => !ids.has(f.id)) }
  }
  const rendered = (list: BotFact[]) => renderMemory({ facts: list, turns: 1, shared: list.length }, NOW).length

  it('caps shared at 14 lines and 1200 chars, own at 8 lines and 600 chars', () => {
    expect(split(facts('s', 20, 60), []).shared).toHaveLength(MEMORY_BUDGET.shared.lines)
    const longShared = split(facts('s', 10, 150), []).shared
    expect(longShared.length).toBeGreaterThan(0)
    expect(rendered(longShared)).toBeLessThanOrEqual(1200)
    expect(split([], facts('b', 12, 50)).own).toHaveLength(MEMORY_BUDGET.own.lines)
    const longOwn = split([], facts('b', 6, 150)).own
    expect(longOwn.length).toBeGreaterThan(0)
    expect(rendered(longOwn)).toBeLessThanOrEqual(600)
    expect(MEMORY_BUDGET).toEqual({ shared: { chars: 1200, lines: 14 }, own: { chars: 600, lines: 8 } })
  })

  it('a full shared layer leaves the own budget intact, shared first, each layer by first written', () => {
    const { all, shared, own } = split(facts('s', 20, 60), facts('b', 12, 50))
    expect(shared).toHaveLength(14)
    expect(own).toHaveLength(8)
    expect(all.slice(0, 14)).toEqual(shared)
    expect(shared.map((f) => f.at)).toEqual(shared.map((f) => f.at).sort())
    expect(own.map((f) => f.at)).toEqual(own.map((f) => f.at).sort())
  })
})
