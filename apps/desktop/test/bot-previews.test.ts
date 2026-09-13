import { expect, it } from 'vitest'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { appendBotTurn, archiveBotTranscript, createBot, initVault } from 'core'
import { botPreviews } from '../src/main/bot-previews.js'

it('previews existing conversations, refreshes changed transcripts, and clears archived messages without changing bots', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const paths = await initVault(await mkdtemp(resolve('tmp/bot-previews-')), { git: false })
  const bot = await createBot(paths, { name: 'Research' })
  expect((await botPreviews(paths, [bot]))[0]?.lastMessage).toBeUndefined()
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: 'The review\n is ready.', at: '2026-01-02T10:00:00Z' })
  const first = (await botPreviews(paths, [bot]))[0]?.lastMessage
  expect(first).toEqual({ role: 'assistant', text: 'The review is ready.', at: '2026-01-02T10:00:00Z' })
  expect((await botPreviews(paths, [bot]))[0]?.lastMessage).toBe(first)
  await appendBotTurn(paths, bot.id, { role: 'user', text: 'Please revise the conclusion.', at: '2026-01-02T10:01:00Z' })
  expect((await botPreviews(paths, [bot]))[0]?.lastMessage?.text).toBe('Please revise the conclusion.')
  await archiveBotTranscript(paths, bot.id)
  expect((await botPreviews(paths, [bot]))[0]?.lastMessage).toBeUndefined()
  expect(bot).not.toHaveProperty('lastMessage')
})
