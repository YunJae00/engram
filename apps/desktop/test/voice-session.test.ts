import { describe, expect, it, vi } from 'vitest'
import type { SdkUserMessage } from '../src/main/engine-claude-session.js'

vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
vi.mock('../src/main/process-client.js', () => ({ spawnRuntime: () => undefined }))

import { VoiceSession } from '../src/main/engine-claude-voice.js'

type Handler = (args: Record<string, unknown>) => Promise<unknown>
const conversation = (): { seen: string[][]; options: Record<string, unknown>[]; sdk: never } => {
  const seen: string[][] = [], options: Record<string, unknown>[] = []
  const sdk = {
    tool: (name: string, _description: string, _shape: unknown, handler: Handler) => ({ name, handler }),
    createSdkMcpServer: (server: { name: string; tools: { name: string; handler: Handler }[] }) => server,
    query: ({ prompt, options: given }: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => (async function* () {
      const heard: string[] = []
      seen.push(heard)
      options.push(given)
      const server = (given['mcpServers'] as Record<string, { tools: { name: string; handler: Handler }[] }>)['voice']!
      for await (const message of prompt) {
        heard.push(message.message.content)
        if (message.message.content.includes('넘겨')) {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: '접수 내역부터 볼게요.' }] } }
          await server.tools.find(one => one.name === 'hand_off')!.handler({ brief: '반품 접수 현황' })
          yield { type: 'assistant', message: { content: [{ type: 'text', text: '남은 말' }] } }
          yield { type: 'result', result: '남은 말' }
          continue
        }
        yield { type: 'result', result: `answer ${heard.length} to ${message.message.content}` }
      }
    })(),
  }
  return { seen, options, sdk: sdk as never }
}

describe('a quick voice answers one prompt and nothing that came before it', () => {
  it('reads only the prompt it was given, then is spent so the next prompt opens a fresh voice', async () => {
    const { seen, sdk } = conversation()
    const voice = new VoiceSession({ sdk, binary: 'fixture', workdir: 'fixture', model: 'haiku' })
    expect(voice.ready).toBe(true)
    await expect(voice.ask('이번 주말 등산 코스 골라줘', 1000)).resolves.toEqual({ text: 'answer 1 to 이번 주말 등산 코스 골라줘' })
    expect(voice.ready).toBe(false)
    expect(voice.spent).toBe(true)
    await expect(voice.ask('사진 폴더 날짜별로 나눠줘', 1000)).rejects.toThrow()
    voice.close()
    const next = new VoiceSession({ sdk, binary: 'fixture', workdir: 'fixture', model: 'haiku' })
    await expect(next.ask('사진 폴더 날짜별로 나눠줘', 1000)).resolves.toEqual({ text: 'answer 1 to 사진 폴더 날짜별로 나눠줘' })
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

  it('offers only the hand-off tool, and a hand-off gives the words said before it with the brief, then closes the voice', async () => {
    const { options, sdk } = conversation()
    const voice = new VoiceSession({ sdk, binary: 'fixture', workdir: 'fixture', model: 'haiku' })
    await expect(voice.ask('지난주 반품 접수 몇 건인지 넘겨서 확인해줘', 1000)).resolves.toEqual({ text: '접수 내역부터 볼게요.', handOff: '반품 접수 현황' })
    expect(options[0]).toMatchObject({ tools: [], permissionMode: 'dontAsk', allowedTools: ['mcp__voice__hand_off'], strictMcpConfig: true })
    await vi.waitFor(() => expect(voice.closed).toBe(true))
  })
})
