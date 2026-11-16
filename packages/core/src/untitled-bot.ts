import { UNTITLED_BOT_NAME } from './bots.js'

// A one-press bot is stored under the UI's translated label (ko: 새 봇), so
// first-message naming must recognize every language's untitled name - and the
// names earlier versions gave, which chats made then still carry.
export const UNTITLED_BOT_NAMES: readonly string[] = [UNTITLED_BOT_NAME, '새 봇', 'New comet', '새 코멧']

export function isUntitledBotName(name: string | undefined): boolean {
  return name !== undefined && UNTITLED_BOT_NAMES.includes(name)
}
