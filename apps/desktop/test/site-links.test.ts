import { expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))
import { answerSites } from '../src/renderer/src/components/SiteIcon.js'
import { routineTask } from '../../../packages/core/src/routine-task.js'

it('ends code-wrapped URLs before adjacent Korean prose', () => {
  const text = '현재 `https://naver.com`을 열었습니다. [Example](https://example.com/path?q=1).'
  expect(answerSites(text).map(site => site.url)).toEqual(['https://naver.com/', 'https://example.com/path?q=1'])
  expect(routineTask(text, []).urls).toEqual(['https://naver.com/', 'https://example.com/path?q=1'])
})
