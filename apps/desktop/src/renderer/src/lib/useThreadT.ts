import { useSyncExternalStore } from 'react'
import { cometThreads } from './cometThreadsLive.js'
import { threadLang, threadT, type ThreadTranslate } from './threadLang.js'

const NONE: { role: string; text: string }[] = []

// The words of a card that sits with a conversation follow that
// conversation's language; a card with no conversation reads in English.
export function useThreadT(botId?: string | null): ThreadTranslate {
  const messages = useSyncExternalStore(cometThreads.subscribe, () => (botId ? cometThreads.thread(botId).messages : NONE))
  return threadT(threadLang(messages))
}
