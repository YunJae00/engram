import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { z, type ZodTypeAny } from 'zod'
import { promptFor } from 'core'
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
    expect(options[0]).toMatchObject({ includePartialMessages: true, tools: [], permissionMode: 'dontAsk', allowedTools: ['mcp__voice__hand_off'], strictMcpConfig: true })
    await vi.waitFor(() => expect(voice.closed).toBe(true))
  })

  it('tells the caller what it said as soon as it starts the hand-off, while the brief is still being written', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>(done => { release = done })
    const sdk = {
      tool: (name: string, _description: string, _shape: unknown, handler: Handler) => ({ name, handler }),
      createSdkMcpServer: (server: { name: string; tools: { name: string; handler: Handler }[] }) => server,
      query: ({ prompt, options: given }: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => (async function* () {
        const server = (given['mcpServers'] as Record<string, { tools: { name: string; handler: Handler }[] }>)['voice']!
        for await (const message of prompt) {
          void message
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '화분 물 준 날짜부터 ' } } }
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '볼게요.' } } }
          yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__voice__hand_off' } } }
          await gate
          yield { type: 'assistant', message: { content: [{ type: 'text', text: '화분 물 준 날짜부터 볼게요.' }] } }
          await server.tools.find(one => one.name === 'hand_off')!.handler({ brief: '화분 물 주기' })
        }
      })(),
    }
    const voice = new VoiceSession({ sdk: sdk as never, binary: 'fixture', workdir: 'fixture', model: 'haiku' })
    const early = vi.fn()
    let settled = false
    const reply = voice.ask('베란다 화분 언제 물 줬는지 기록 찾아줘', 1000, early).then(value => { settled = true; return value })
    await vi.waitFor(() => expect(early).toHaveBeenCalledExactlyOnceWith('화분 물 준 날짜부터 볼게요.'))
    expect(settled).toBe(false)
    release()
    await expect(reply).resolves.toEqual({ text: '화분 물 준 날짜부터 볼게요.', handOff: '화분 물 주기' })
    expect(early).toHaveBeenCalledOnce()
  })

  it('a quick turn sends the model no more text than the first-line turn it replaced: its prompt plus every tool name, description and schema', async () => {
    const parent = JSON.parse(readFileSync(new URL('fixtures/prompts-parent.json', import.meta.url), 'utf8')) as Record<string, string>
    for (const [key, korean, said] of [['ack-ko', true, []], ['ack-en', false, []], ['ack-ko-said', true, ['지금 시세 확인할게요.']]] as [string, boolean, string[]][]) {
      const was = parent[key]!
      const message = JSON.parse(was.split('\n').pop()!.slice('Request: '.length)) as string
      const tools: string[] = []
      const heard: string[] = []
      const sdk = {
        tool: (name: string, description: string, shape: Record<string, ZodTypeAny>) => ({ name, description, shape }),
        createSdkMcpServer: (server: { name: string; tools: { name: string; description: string; shape: Record<string, ZodTypeAny> }[] }) => {
          for (const one of server.tools) tools.push(`mcp__${server.name}__${one.name}`, one.description, JSON.stringify(z.toJSONSchema(z.object(one.shape))))
          return server
        },
        query: ({ prompt }: { prompt: AsyncIterable<SdkUserMessage> }) => (async function* () {
          for await (const turn of prompt) { heard.push(turn.message.content); yield { type: 'result', result: '네' } }
        })(),
      }
      const voice = new VoiceSession({ sdk: sdk as never, binary: 'fixture', workdir: 'fixture', model: 'haiku' })
      await voice.ask(promptFor('quick', { message, korean, said }), 1000)
      voice.close()
      expect(tools.length, key).toBeGreaterThan(0)
      expect([...heard, ...tools].join('').length, key).toBeLessThanOrEqual(was.length)
    }
  })
})
