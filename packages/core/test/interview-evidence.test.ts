import { expect, it } from 'vitest'
import { INTERVIEW_SOURCE_ID, selectInterviewEvidence, type InterviewEvidence } from '../src/interview-evidence.js'
import { INTERVIEW_SCHEMA, interviewPrompt, parseInterviewQuestions } from '../src/work-guide.js'
import type { WorkMap, WorkPlace } from '../src/work-map.js'
import type { Playbook } from '../src/task-playbooks.js'

const now = new Date('2026-10-08T12:00:00Z')
const place = (host: string, overrides: Partial<WorkPlace> = {}): WorkPlace => ({
  host, entry: `https://${host}/`, title: 'Review requests', pages: [], days: 5, lastSeen: '2026-10-08', bookmarks: [], managed: false, work: true, ...overrides,
})
const map = (...places: WorkPlace[]): WorkMap => ({ builtAt: now.toISOString(), windowDays: 90, places })
const task = (goal: string, overrides: Partial<Playbook> = {}): Playbook => ({ goal, urls: [], method: [], at: '2026-10-07T10:00:00Z', count: 1, ...overrides })
const question = (source: string, text = 'Which result should I prepare next time?') => ({ source, topic: 'outputs', question: text, basis: 'A previous completed task', options: ['A short summary', 'The full report'] })

it('cannot make questions eligible from unrelated files, bookmarks alone, or ambiguous sites', () => {
  const evidence = selectInterviewEvidence({ now, map: map(
    place('managed.example', { days: 0, lastSeen: '', bookmarks: ['Company / Home'], managed: true }),
    place('personal.example', { days: 0, lastSeen: '', bookmarks: ['Saved item'] }),
    place('unknown.example', { days: 20, work: undefined }),
    place('personal-use.example', { days: 20, work: false }),
    place('unclear.example', { title: 'unclear.example', purpose: '' }),
  ) })
  expect(evidence.sources).toEqual([])
  const legacy: InterviewEvidence = { files: ['Desktop/old-download/invoice.csv'], places: ['video.example'], facts: ['Maybe an accountant'] }
  expect(interviewPrompt(legacy)).not.toContain('invoice.csv')
  expect(interviewPrompt(legacy)).toContain('Eligible sources: []')
  expect(parseInterviewQuestions(JSON.stringify({ questions: [question(`place-${'a'.repeat(24)}`)] }), evidence)).toEqual([])
})

it('uses actual recent repeat use for ranking without turning inferred work into confirmed importance', () => {
  const evidence = selectInterviewEvidence({ now, map: map(
    place('older.example', { days: 40, lastSeen: '2026-09-01' }),
    place('fewer.example', { days: 3 }),
    place('frequent.example', { days: 12 }),
    place('recent.example', { days: 10, lastSeen: '2026-10-07' }),
    place('old-frequent.example', { days: 12, lastSeen: '2026-09-15' }),
    place('single.example', { days: 1 }),
    place('invalid.example', { lastSeen: 'not-a-date' }),
    place('bad-label.example', { title: 7 as unknown as string, purpose: {} as unknown as string }),
    place('bad-count.example', { days: '20' as unknown as number }),
  ) })
  expect(evidence.sources!.map(one => one.grounding.hosts![0])).toEqual(['frequent.example', 'recent.example', 'fewer.example', 'old-frequent.example'])
  expect(evidence.sources![0]!.grounding).toMatchObject({ visitDays: 12, workClassification: 'inferred', bookmark: 'none' })
  expect(interviewPrompt(evidence)).toContain('Visit days measure use, not importance')
  expect(interviewPrompt(evidence)).toContain('inferred, not confirmed')
})

it('keeps rare completed work above browsing and preserves known work even when task history fills the limit', () => {
  const evidence = selectInterviewEvidence({ now,
    playbooks: [task('Review the annual renewal', { at: '2025-10-08T12:00:00Z' }), task('Prepare the weekly handover', { count: 5 })],
    map: map(place('daily.example', { days: 80 })),
    guide: '## Recurring work\n- The annual renewal is important even though I do it once a year.',
  })
  expect(evidence.sources!.map(one => one.kind)).toEqual(['task', 'task', 'guide', 'place'])
  expect(evidence.sources![0]!.label).toBe('Prepare the weekly handover')
  expect(evidence.sources![1]!.grounding.completedCount).toBe(1)
  expect(evidence.sources![2]!.grounding.guideStatement).toContain('once a year')
  const crowded = selectInterviewEvidence({ now, playbooks: Array.from({ length: 15 }, (_, i) => task(`Completed task ${i}`)), guide: '## Rules\n- Keep the original identifiers.' })
  expect(crowded.sources).toHaveLength(8)
  expect(crowded.sources!.some(one => one.kind === 'guide')).toBe(true)
})

it('keeps stable source IDs across ranking changes and excludes a rejected source', () => {
  const a = selectInterviewEvidence({ now, playbooks: [task(' Prepare   the review ')], map: map(place('WORK.EXAMPLE')) })
  const b = selectInterviewEvidence({ now, playbooks: [task('prepare the REVIEW', { count: 8, at: now.toISOString() })], map: map(place('work.example', { days: 20 })) })
  expect(a.sources!.map(one => one.id)).toEqual(b.sources!.map(one => one.id))
  expect(a.sources!.every(one => INTERVIEW_SOURCE_ID.test(one.id))).toBe(true)
  const excluded = selectInterviewEvidence({ now, playbooks: [task('prepare the review')], map: map(place('work.example')), excludedIds: a.sources!.map(one => one.id) })
  expect(excluded.sources).toEqual([])
})

it('does not ask about a task host again or treat generated guide boilerplate as work', () => {
  const evidence = selectInterviewEvidence({ now, playbooks: [task('Prepare a weekly review', { urls: ['https://work.example/reviews'] })], map: map(place('work.example')) })
  expect(evidence.sources.map(one => one.kind)).toEqual(['task'])
  expect(selectInterviewEvidence({ guide: '# How I work\n\nMy own answers about my work. Every comet reads this; edit or delete anything.' }).sources).toEqual([])
  expect(selectInterviewEvidence({ guide: 'My own answers about my work. Every comet reads this; edit or delete anything.' }).sources).toEqual([])
})

it('carries safe hostnames and useful work labels without local paths, methods, or URL secrets', () => {
  const evidence = selectInterviewEvidence({ now, playbooks: [task('Prepare the review in C:\\Private\\report.xlsx from /srv/internal/plan.csv and reviews/last.xlsx', {
    urls: ['https://work.example/private/customer?token=hidden', 'file:///C:/Private/report.xlsx', 'https://user:password@secret.example/a'],
    method: ['Secret method or screenshot contents'],
  })] })
  const prompt = interviewPrompt(evidence)
  expect(evidence.sources![0]!.grounding.hosts).toEqual(['work.example'])
  expect(prompt).toContain('Prepare the review in')
  for (const text of ['Private', '/srv/', 'reviews/last.xlsx', 'token=hidden', '/private/customer', 'password', 'Secret method']) expect(prompt).not.toContain(text)
})

it('removes quoted and spaced paths while keeping ordinary slash choices readable', () => {
  const goals = [
    'Prepare the review from "C:\\Team Files\\Quarterly Review.xlsx"',
    "Prepare the review from 'C:/Team Files/Quarterly Review.xlsx'",
    'Prepare the review from C:\\Team Files\\Quarterly Review.xlsx today',
    'Prepare the review from /home/user/Quarterly Review.xlsx today',
    'Prepare the review from Finance/Quarterly Review.xlsx today',
  ]
  for (const goal of goals) {
    const evidence = selectInterviewEvidence({ now, playbooks: [task(goal)] })
    expect(evidence.sources[0]?.label).toContain('Prepare the review from')
    expect(interviewPrompt(evidence)).not.toContain('Quarterly Review.xlsx')
    expect(interviewPrompt(evidence)).not.toContain('Team Files')
    const source = evidence.sources[0]!.id
    expect(parseInterviewQuestions(JSON.stringify({ questions: [question(source, `How should I do this: ${goal}?`)] }), evidence)).toEqual([])
    expect(parseInterviewQuestions(JSON.stringify({ questions: [{ ...question(source), options: ['Yes/no summary', 'CSV/PDF export'] }] }), evidence)[0]?.options).toEqual(['Yes/no summary', 'CSV/PDF export'])
  }
})

it('handles weakly validated map fields and a manually edited guide without invented work', () => {
  expect(selectInterviewEvidence({ map: { places: null } as unknown as WorkMap, guide: null as unknown as string }).sources).toEqual([])
  const malformed = map(null as unknown as WorkPlace, place('empty.example', { title: null as unknown as string, purpose: null as unknown as string }), place('valid.example', { bookmarks: null as unknown as string[] }))
  expect(selectInterviewEvidence({ now, map: malformed }).sources.map(one => one.grounding.hosts![0])).toEqual(['valid.example'])
  const manual = selectInterviewEvidence({ guide: '## Important work\nAnnual renewals need careful review even though they are rare.' })
  expect(manual.sources[0]?.grounding.guideStatement).toContain('Annual renewals')
  const long = selectInterviewEvidence({ guide: `## Rules\n- ${'Long rule. '.repeat(2000)}` })
  expect(long.guide!.length).toBeLessThanOrEqual(12000)
  expect(long.sources[0]!.grounding.guideStatement!.length).toBeLessThanOrEqual(400)
})

it('allows only eligible source IDs, one concise question per source, and no path-heavy response', () => {
  const evidence = selectInterviewEvidence({ now, playbooks: [task('Prepare the review'), task('Review request exceptions')], guide: '- Keep identifiers unchanged.' })
  const [a, b, c] = evidence.sources!.map(one => one.id) as [string, string, string]
  const raw = JSON.stringify({ questions: [
    question(`task-${'0'.repeat(24)}`, 'An invented task?'),
    question(a, 'What happens in C:\\Private\\report.xlsx?'),
    question(a, 'What happens in /srv/private/report.csv?'),
    question(a, 'What goes in reports/final.xlsx?'),
    question(a),
    question(a, 'A second issue about the same task?'),
    question(b, 'Who approves? And what columns do you need?'),
    { ...question(b, 'What should the result include?'), basis: 'See https://work.example/private/path' },
    question(b, 'x'.repeat(161)),
    { ...question(b), options: ['Store at C:\\Private\\output.xlsx', 'Keep it here'] },
    { ...question(b), options: ['x'.repeat(101), 'A short answer'] },
    question(c, 'Which exception needs your review?'),
  ] })
  expect(parseInterviewQuestions(raw, evidence).map(one => one.source)).toEqual([a, c])
  expect(INTERVIEW_SCHEMA.properties.questions.maxItems).toBe(5)
  expect(INTERVIEW_SCHEMA.properties.questions.items.required).toContain('source')
})
