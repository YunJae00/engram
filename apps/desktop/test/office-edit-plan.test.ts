import { expect, it } from 'vitest'
import { planOfficeEdits } from '../src/main/office-edit-plan.js'
it('plans replacements sequentially and preserves the offsets needed to retain formatting', () => {
  const plan = planOfficeEdits([{ key: 'body', text: 'A A\r' }], [
    { kind: 'replace', find: 'A', with: '한글' }, { kind: 'append', text: 'Last\nline' },
  ], 'word')
  expect(plan[0]).toMatchObject({ positions: [0, 2], before: 'A A\r', after: '한글 한글\r' })
  expect(plan[1]).toMatchObject({ before: '한글 한글\r', after: '한글 한글\rLast\rline\r' })
})
it('refuses the entire plan when a later replacement or target is absent', () => {
  const state = [{ key: '1:1', text: 'Original' }]
  expect(() => planOfficeEdits(state, [{ kind: 'replace', find: 'Original', with: 'New' }, { kind: 'replace', find: 'Missing', with: 'x' }], 'ppt')).toThrow('No literal')
  expect(() => planOfficeEdits(state, [{ kind: 'note', slide: 1, text: 'x' }], 'ppt')).toThrow('not present')
  expect(state[0]!.text).toBe('Original')
})
