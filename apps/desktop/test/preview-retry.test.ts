import { expect, it } from 'vitest'
import { PreviewRetry } from '../src/main/preview-retry.js'
it('backs off from three seconds to thirty and resets on success or a new task', () => {
  const retry = new PreviewRetry()
  expect([0, 1, 2, 3, 4, 5].map(() => retry.fail('lane', 0))).toEqual([3000, 6000, 12000, 24000, 30000, 30000])
  expect(retry.ready('lane', 29999)).toBe(false)
  expect(retry.ready('other', 0)).toBe(true)
  retry.reset('lane')
  expect(retry.ready('lane', 0)).toBe(true)
  expect(retry.fail('lane', 0)).toBe(3000)
  expect(retry.log('lane', 'capture_unavailable', 0)).toBe(true)
  expect(retry.log('lane', 'capture_unavailable', 59999)).toBe(false)
  expect(retry.log('lane', 'capture_unavailable', 60000)).toBe(true)
})
