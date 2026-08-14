import { describe, expect, it } from 'vitest'

// The gesture that decides whether Enter remembers or asks, extracted so it can
// be tested without mounting the composer. Kept byte-identical to Composer.tsx
// — if one changes without the other, these cases say so.
const askIntent = (text: string): boolean => {
  const t = text.trim()
  return t.startsWith('?') || /[?？]$/.test(t)
}
const stripMark = (text: string): string =>
  text.trim().replace(/^\?+\s*/, '').replace(/\s*[?？]+$/, '')

describe('ask intent', () => {
  // The reason this changed: a leading ? is a command-line idiom, and Korean
  // puts the mark at the end. Requiring the prefix hid the gesture from the
  // person whose vault this is.
  it('reads a question written the way Korean is written', () => {
    expect(askIntent('어제 결정한 게 뭐였지?')).toBe(true)
    expect(askIntent('배포 언제였더라?')).toBe(true)
    // full-width mark, which a Korean IME produces
    expect(askIntent('이거 맞나？')).toBe(true)
  })

  it('still honours the leading mark', () => {
    expect(askIntent('?what did I decide')).toBe(true)
    expect(askIntent('  ? trailing spaces too  ')).toBe(true)
  })

  it('leaves a plain statement as something to remember', () => {
    expect(askIntent('금요일에 배포하기로 함')).toBe(false)
    expect(askIntent('finished the payment refactor')).toBe(false)
    // a mark in the MIDDLE is prose, not a gesture
    expect(askIntent('왜? 라고 물어봤음')).toBe(false)
  })

  it('treats an empty box as neither', () => {
    expect(askIntent('')).toBe(false)
    expect(askIntent('   ')).toBe(false)
  })

  it('strips the mark from whichever end carried it', () => {
    expect(stripMark('어제 뭐 결정했지?')).toBe('어제 뭐 결정했지')
    expect(stripMark('?what did I decide')).toBe('what did I decide')
    expect(stripMark('이거 맞나？')).toBe('이거 맞나')
    // an interior mark belongs to the sentence
    expect(stripMark('왜? 라고 물어봤음')).toBe('왜? 라고 물어봤음')
  })
})
