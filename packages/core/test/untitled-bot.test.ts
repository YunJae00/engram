import { describe, expect, it } from 'vitest'
import { UNTITLED_BOT_NAME } from '../src/bots.js'
import { isUntitledBotName, UNTITLED_BOT_NAMES } from '../src/untitled-bot.js'

describe('untitled bot names', () => {
  it('recognizes the English and Korean one-press names and nothing else', () => {
    expect(isUntitledBotName(UNTITLED_BOT_NAME)).toBe(true)
    expect(isUntitledBotName('새 코멧')).toBe(true)
    // qa146: the one-press name says bot; chats named by earlier versions are still untitled.
    expect(UNTITLED_BOT_NAME).toBe('New bot')
    expect(isUntitledBotName('새 봇')).toBe(true)
    expect(isUntitledBotName('New comet')).toBe(true)
    expect(isUntitledBotName('Deploy notes')).toBe(false)
    expect(isUntitledBotName('')).toBe(false)
    expect(isUntitledBotName(undefined)).toBe(false)
    expect(UNTITLED_BOT_NAMES).toContain(UNTITLED_BOT_NAME)
  })
})
