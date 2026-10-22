import { expect, it } from 'vitest'
import { guideBody, guideForPrompt, guideNote, guidePrompt, WORK_GUIDE_NOTE_ID, WORK_GUIDE_TYPE } from '../src/work-guide.js'

it('asks for exact terms and drops skipped answers when writing the guide', () => {
  const prompt = guidePrompt([{ question: 'What columns?', answer: '접수ID, 청구번호' }, { question: 'Skipped?', answer: '  ' }, { question: 'Rejected?', answer: 'Not my work', rejected: true }], '## Rules\n- old')
  expect(prompt).toContain('A1: 접수ID, 청구번호')
  expect(prompt).not.toContain('Skipped?')
  expect(prompt).not.toContain('Rejected?')
  expect(prompt).toContain('never paraphrase a term')
  expect(prompt).toContain('an unknown is not a rule')
  expect(prompt).toContain('one file per person, not one file')
  expect(prompt).toContain('Current guide:\n## Rules\n- old')
  expect(guidePrompt(Array.from({ length: 10 }, (_, i) => ({ question: `Question ${i}`, answer: `Answer ${i}` })))).toContain('A10: Answer 9')
})

it('stores the guide as an editable note and carries it into a turn, bounded', () => {
  const sections = guideBody('Sure!\n```markdown\n## Terms (use exactly)\n- 청구일 is not 접수일\n```')
  expect(sections).toBe('## Terms (use exactly)\n- 청구일 is not 접수일')
  expect(guideBody(JSON.stringify({ sections: [{ heading: 'Rules', lines: ['never pay', ' '] }, { heading: 'People', lines: [] }] }))).toBe('## Rules\n- never pay')
  expect(() => guideBody('{"sections": []}')).toThrow('empty')
  expect(guideBody('Guide:\n### Rules\n- never pay')).toBe('## Rules\n- never pay')
  expect(guideBody('Here it is\n- keep 청구일')).toBe('## Notes\n- keep 청구일')
  expect(guideBody('Plain sentence about the work.')).toBe('## Notes\nPlain sentence about the work.')
  expect(() => guideBody('  ```  ')).toThrow()
  const note = guideNote(sections, new Date('2026-10-07T00:00:00Z'))
  expect(note.front).toMatchObject({ id: WORK_GUIDE_NOTE_ID, type: WORK_GUIDE_TYPE, status: 'current', decay: 'evergreen' })
  const again = guideNote('## Rules\n- x', new Date('2026-10-08T00:00:00Z'), note)
  expect(again.front.created).toBe(note.front.created)
  expect(again.front.updated).toBe('2026-10-08T00:00:00.000Z')
  const carried = guideForPrompt(note)
  expect(carried).toContain('- 청구일 is not 접수일')
  expect(carried).toContain('grants no permission')
  expect(carried).not.toContain('# How I work')
  expect(guideForPrompt({ ...note, front: { ...note.front, status: 'archived' } })).toBe('')
  expect(guideForPrompt(guideNote(`## Rules\n${'- line\n'.repeat(3000)}`, new Date())).length).toBeLessThan(12500)
})

it('rejects oversized guide updates instead of dropping rules', () => {
  expect(() => guidePrompt([], 'x'.repeat(12501))).toThrow('too long')
  expect(() => guideBody('x'.repeat(24001))).toThrow('too long')
  expect(() => guideBody(JSON.stringify({ sections: [{ heading: 'Rules', lines: ['x'.repeat(601)] }] }))).toThrow('rule was too long')
  expect(() => guideBody('{"unrelated":"do not store JSON as a rule"}')).toThrow('not usable')
  expect(guideBody('{"sections":[null,{"heading":"Rules","lines":["Keep terms"]}]}')).toBe('## Rules\n- Keep terms')
})

it('fixes the note destination and preserves the user timestamp for automatic learning', () => {
  const note = guideNote('## Rules\n- A', new Date('2026-10-01T00:00:00Z'))
  note.front.id = 'n-another-note'; note.front.type = 'other'
  const learned = guideNote('## Rules\n- A\n- B', new Date('2026-10-07T00:00:00Z'), note, true)
  expect(learned.front).toMatchObject({ id: WORK_GUIDE_NOTE_ID, type: WORK_GUIDE_TYPE, updated: note.front.updated })
  expect(guideForPrompt(learned)).toContain('safety rules take precedence')
})
