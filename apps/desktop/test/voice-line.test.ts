import { expect, it } from 'vitest'
import { askInTurn, type VoiceLike } from '../src/main/voice-line.js'

function slowVoice(ms: number): VoiceLike & { asked: string[] } {
  let busy = false
  const voice = {
    closed: false,
    asked: [] as string[],
    get ready() { return !busy },
    async ask(prompt: string) {
      busy = true
      voice.asked.push(prompt)
      await new Promise(resolve => setTimeout(resolve, ms))
      busy = false
      return `answer to ${prompt}`
    },
  }
  return voice
}

it('lets questions that arrive together wait their turn instead of failing', async () => {
  const voice = slowVoice(50)
  const answers = await Promise.all(['one', 'two', 'three'].map(prompt => askInTurn(async () => voice, prompt, 2000)))
  expect(answers).toEqual(['answer to one', 'answer to two', 'answer to three'])
  expect(voice.asked).toEqual(['one', 'two', 'three'])
})

it('gives up on a question whose own time ran out while it waited', async () => {
  const voice = slowVoice(300)
  const first = askInTurn(async () => voice, 'long', 2000)
  await expect(askInTurn(async () => voice, 'short', 100)).rejects.toThrow('The voice')
  await expect(first).resolves.toBe('answer to long')
  await expect(askInTurn(async () => undefined, 'none', 100)).rejects.toThrow('The voice is not ready.')
})
