import { expect, it } from 'vitest'
import { helpersTool } from '../src/helper-tool.js'

it('looks into separate questions at once and brings each back, failed ones said plainly', async () => {
  const started: number[] = []
  let running = 0, most = 0
  const tool = helpersTool({
    look: async (question, index) => {
      started.push(index)
      running++; most = Math.max(most, running)
      await new Promise(resolve => setTimeout(resolve, 20))
      running--
      if (question.includes('Catchtable')) throw new Error('the page did not open')
      return `Found it for ${index + 1} at https://example.com/${index + 1}`
    },
  })
  const found = await tool.run({ questions: ['Friday tables on Naver for 노량진 초장집', 'Friday tables on Catchtable for 노량진 초장집', 'Opening hours on Friday'] }, { task: '' })
  expect(most).toBe(3)
  expect(found).toContain('1. Friday tables on Naver')
  expect(found).toContain('https://example.com/1')
  expect(found).toContain('Could not finish: the page did not open')
  expect(found).toContain('https://example.com/3')
  await expect(tool.run({ questions: ['Only one question here'] }, { task: '' })).rejects.toThrow('two or three')
})
