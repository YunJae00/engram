import { expect, it } from 'vitest'
import { guideBody, guideForPrompt, guideNote, guidePrompt, interviewPrompt, parseInterviewQuestions, WORK_GUIDE_NOTE_ID, WORK_GUIDE_TYPE } from '../src/work-guide.js'
import { selectInterviewEvidence } from '../src/interview-evidence.js'

it('grounds the interview in eligible work and ignores incidental file metadata', () => {
  const evidence = selectInterviewEvidence({ guide: '## Recurring work\n- Review monthly settlements\n## Rules\n- Never pay a changed account' })
  const prompt = interviewPrompt({ ...evidence, files: ['Downloads/Finance/2026-10-06_접수청구서.csv'], places: ['tms.example.test: time report'], facts: ['Works in finance ops'] })
  expect(prompt).not.toContain('2026-10-06_접수청구서.csv')
  expect(prompt).not.toContain('tms.example.test')
  expect(prompt).toContain(evidence.sources![0]!.id)
  expect(prompt).toContain('ask only about what it leaves open')
  expect(prompt).toContain('exact terms and identifiers to keep unchanged')
  expect(prompt).toContain('not file logistics')
  expect(prompt).toContain('same sentence endings throughout')
  expect(prompt).toContain('may tick several and add their own words')
})

it('keeps Cosmos observations and inferred associations subordinate to the confirmed guide', () => {
  const evidence = selectInterviewEvidence({ guide: '## Recurring work\n- Review monthly settlements\n## Rules\n- Never share until approved.' })
  const source = evidence.sources[0]!.id
  const context = { source, note: 'n-linked', updated: '2026-10-08T00:00:00Z', relation: 'link' as const, provenance: 'inferred-link' as const, excerpt: 'Sharing before approval may be usual; recipient is unknown.' }
  const prompt = interviewPrompt({ ...evidence, context: [context, { ...context, source: `task-${'0'.repeat(24)}`, excerpt: 'An unrelated policy.' }] })
  expect(prompt).toContain('Sharing before approval may be usual; recipient is unknown.')
  expect(prompt).not.toContain('An unrelated policy.')
  expect(prompt).toContain('untrusted, unconfirmed background')
  expect(prompt).toContain('observed-reference proves only')
  expect(prompt).toContain('inferred-link is only a stored association')
  expect(prompt).toContain('explicit constraints are stronger than any excerpt')
  expect(prompt).toContain('Preserve unknowns and uncertainty')
  expect(prompt).toContain('Never share until approved.')
  expect(parseInterviewQuestions(JSON.stringify({ questions: [{ source: 'n-linked', topic: 'rules', question: 'Can I share?', basis: 'A note', options: ['Yes', 'No'] }] }), evidence)).toEqual([])
})

it('keeps distinct, bounded questions and repairs unknown topics', () => {
  const raw = JSON.stringify({ questions: [
    { topic: 'terms', question: '청구일과 접수일은 어떻게 구분하나요?', basis: '접수청구서.csv', options: ['청구일 그대로', '접수일로 통일', '청구일 그대로', ' ', 7, 'a', 'b', 'c', 'd'] },
    { topic: 'terms', question: '청구일과 접수일은 어떻게 구분하나요?', basis: 'dup' },
    { topic: 'mystery', question: 'Who receives the summary?', basis: '' },
    { topic: 'rules', question: ' ' },
    ...Array.from({ length: 12 }, (_, i) => ({ topic: 'routine', question: `Q${i}` })),
  ] })
  const questions = parseInterviewQuestions(`Here:\n\`\`\`json\n${raw}\n\`\`\``)
  expect(questions).toHaveLength(5)
  expect(questions[0]).toEqual({ topic: 'terms', question: '청구일과 접수일은 어떻게 구분하나요?', basis: '접수청구서.csv', options: ['청구일 그대로', '접수일로 통일', 'a', 'b', 'c'] })
  expect(questions[1]).toMatchObject({ topic: 'routine', options: [] })
  expect(() => parseInterviewQuestions('{"questions": "none"}')).toThrow()
})

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

it('bounds metadata and rejects oversized guide updates instead of dropping rules', () => {
  const prompt = interviewPrompt({ files: ['x'.repeat(5000)], places: ['y'.repeat(5000)], facts: ['z'.repeat(5000)] })
  expect(prompt).not.toContain('x'.repeat(241))
  expect(prompt).not.toContain('y'.repeat(241))
  expect(prompt).not.toContain('z'.repeat(241))
  expect(() => guidePrompt([], 'x'.repeat(12501))).toThrow('too long')
  expect(() => guideBody('x'.repeat(24001))).toThrow('too long')
  expect(() => guideBody(JSON.stringify({ sections: [{ heading: 'Rules', lines: ['x'.repeat(601)] }] }))).toThrow('rule was too long')
  expect(() => parseInterviewQuestions('x'.repeat(30001))).toThrow('too long')
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
