import { describe, expect, it, vi } from 'vitest'
import type { SdkUserMessage } from '../src/main/engine-claude-session.js'

vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
vi.mock('../src/main/process-client.js', () => ({ spawnRuntime: () => undefined }))

import { VoiceSession } from '../src/main/engine-claude-voice.js'

const conversation = (): { seen: string[][]; sdk: never } => {
  const seen: string[][] = []
  const sdk = {
    query: ({ prompt }: { prompt: AsyncIterable<SdkUserMessage> }) => (async function* () {
      const heard: string[] = []
      seen.push(heard)
      for await (const message of prompt) {
        heard.push(message.message.content)
        yield { type: 'result', result: `answer ${heard.length} to ${message.message.content}` }
      }
    })(),
  }
  return { seen, sdk: sdk as never }
}

describe('a quick voice answers one prompt and nothing that came before it', () => {
  it('reads only the prompt it was given, then is spent so the next prompt opens a fresh voice', async () => {
    const { seen, sdk } = conversation()
    const voice = new VoiceSession({ sdk, binary: 'fixture', workdir: 'fixture', model: 'haiku' })
    expect(voice.ready).toBe(true)
    await expect(voice.ask('이번 주말 등산 코스 골라줘', 1000)).resolves.toBe('answer 1 to 이번 주말 등산 코스 골라줘')
    expect(voice.ready).toBe(false)
    expect(voice.spent).toBe(true)
    await expect(voice.ask('사진 폴더 날짜별로 나눠줘', 1000)).rejects.toThrow()
    voice.close()
    const next = new VoiceSession({ sdk, binary: 'fixture', workdir: 'fixture', model: 'haiku' })
    await expect(next.ask('사진 폴더 날짜별로 나눠줘', 1000)).resolves.toBe('answer 1 to 사진 폴더 날짜별로 나눠줘')
    next.close()
    expect(seen).toEqual([['이번 주말 등산 코스 골라줘'], ['사진 폴더 날짜별로 나눠줘']])
  })

  it('is not spent while its one answer is still coming', async () => {
    const { sdk } = conversation()
    const voice = new VoiceSession({ sdk, binary: 'fixture', workdir: 'fixture', model: 'haiku' })
    const answer = voice.ask('도서관 반납일 알려줘', 1000)
    expect(voice.ready).toBe(false)
    expect(voice.spent).toBe(false)
    await answer
    expect(voice.spent).toBe(true)
    voice.close()
  })
})
