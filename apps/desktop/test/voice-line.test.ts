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

it('questions asked together go side by side to the idle voices, one lane each, and a fourth waits for the least busy', async () => {
  const lanes = [slowVoice(200), slowVoice(200), slowVoice(200)]
  const began = Date.now()
  const answers = await Promise.all(['목포', '여수', '통영'].map(prompt => askInTurn(async lane => lanes[lane], prompt, 2000, 3)))
  expect(answers).toEqual(['answer to 목포', 'answer to 여수', 'answer to 통영'])
  expect(Date.now() - began).toBeLessThan(380)
  expect(lanes.map(voice => voice.asked)).toEqual([['목포'], ['여수'], ['통영']])
  const four = await Promise.all(['a', 'b', 'c', 'd'].map(prompt => askInTurn(async lane => lanes[lane], prompt, 2000, 3)))
  expect(four).toHaveLength(4)
  expect(lanes.map(voice => voice.asked.length).sort()).toEqual([2, 2, 3])
})
