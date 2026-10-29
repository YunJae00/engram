import { expect, it } from 'vitest'
import { parseMacAppUse } from '../src/main/mac-app-usage.js'
it('reads native app usage metadata without inventing unavailable focus time', () => {
  expect(parseMacAppUse('Excel\0' + '2026-10-28 10:00:00 +0000\0' + '12')).toEqual({ name: 'Excel', runs: 12, focusMs: 0, lastRun: Date.UTC(2026, 9, 28, 10) })
  expect(parseMacAppUse('Excel\0(null)\0(null)')).toBeUndefined()
  expect(parseMacAppUse('Excel\0(null)\0-1')).toBeUndefined()
})
