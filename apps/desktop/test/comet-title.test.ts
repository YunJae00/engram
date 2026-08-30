import { describe, expect, it } from 'vitest'
import { tidyTitle } from '../src/main/comet-title.js'

describe('a comet name from the brain is one short line', () => {
  it('takes the first line and strips quotes, labels and a full stop', () => {
    expect(tidyTitle('"Water on Coupang"')).toBe('Water on Coupang')
    expect(tidyTitle('Title: Weekly time report.')).toBe('Weekly time report')
    expect(tidyTitle('\n  쿠팡 생수 확인  \n\nmore words')).toBe('쿠팡 생수 확인')
  })

  it('gives nothing back for an empty or a rambling answer', () => {
    expect(tidyTitle('')).toBeNull()
    expect(tidyTitle('"'.repeat(3))).toBeNull()
    expect(tidyTitle('This conversation is about checking which bottled water is on offer today')).toBeNull()
  })
})
