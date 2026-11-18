import { UNTITLED_BOT_NAME } from './bots.js'

export const UNTITLED_BOT_NAMES: readonly string[] = [UNTITLED_BOT_NAME, '새 봇', 'New comet', '새 코멧']

export function isUntitledBotName(name: string | undefined): boolean {
  return name !== undefined && UNTITLED_BOT_NAMES.includes(name)
}
