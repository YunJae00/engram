import { expect, test } from 'vitest'
import type { BotDto } from '../src/shared/types.js'
import { isEmptyUntitled } from '../src/renderer/src/lib/sidebarBots.js'

const bot = (patch: Partial<BotDto> = {}): BotDto => ({ id: 'b1', name: 'New comet', purpose: '', createdAt: '2026-11-14T00:00:00.000Z', ...patch } as BotDto)

test('only an untitled bot with no messages counts as empty', () => {
  expect(isEmptyUntitled(bot(), 'New comet', 0)).toBe(true)
  expect(isEmptyUntitled(undefined, 'New comet', 0)).toBe(false)
  expect(isEmptyUntitled(bot({ name: 'Kept' }), 'New comet', 0)).toBe(false)
  expect(isEmptyUntitled(bot({ lastMessage: { at: '2026-11-14T00:00:00.000Z', text: 'hi' } as BotDto['lastMessage'] }), 'New comet', 0)).toBe(false)
  expect(isEmptyUntitled(bot(), 'New comet', 2)).toBe(false)
})
