import { useSyncExternalStore } from 'react'
import { cometThreads } from './cometThreadsLive.js'
import { threadLang, threadT, type ThreadTranslate } from './threadLang.js'

const NONE: { role: string; text: string }[] = []

export function useThreadT(botId?: string | null): ThreadTranslate {
  const messages = useSyncExternalStore(cometThreads.subscribe, () => (botId ? cometThreads.thread(botId).messages : NONE))
  return threadT(threadLang(messages))
}
