import { expect, test } from 'vitest'
import type { BotDto } from '../src/shared/types.js'
import { isEmptyUntitled } from '../src/renderer/src/lib/sidebarBots.js'
import { isUntitledBotName } from 'core'
import { en } from '../src/renderer/src/i18n'
import { ko } from '../src/renderer/src/i18n-ko'

const bot = (patch: Partial<BotDto> = {}): BotDto => ({ id: 'b1', name: 'New comet', purpose: '', createdAt: '2026-11-14T00:00:00.000Z', ...patch } as BotDto)

test('only an untitled bot with no messages counts as empty', () => {
  expect(isEmptyUntitled(bot(), 'New comet', 0)).toBe(true)
  expect(isEmptyUntitled(undefined, 'New comet', 0)).toBe(false)
  expect(isEmptyUntitled(bot({ name: 'Kept' }), 'New comet', 0)).toBe(false)
  expect(isEmptyUntitled(bot({ lastMessage: { at: '2026-11-14T00:00:00.000Z', text: 'hi' } as BotDto['lastMessage'] }), 'New comet', 0)).toBe(false)
  expect(isEmptyUntitled(bot(), 'New comet', 2)).toBe(false)
})

test('every language\'s + name is one the first message can rename', () => {
  expect(isUntitledBotName(en['bots.untitled'])).toBe(true)
  expect(isUntitledBotName(ko['bots.untitled'])).toBe(true)
})
