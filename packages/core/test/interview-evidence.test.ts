import { expect, it } from 'vitest'
import { INTERVIEW_SOURCE_ID, selectInterviewEvidence, type InterviewEvidence } from '../src/interview-evidence.js'
import { INTERVIEW_SCHEMA, interviewPrompt, parseInterviewQuestions } from '../src/work-guide.js'
import type { WorkMap, WorkPlace } from '../src/work-map.js'
import type { Playbook } from '../src/task-playbooks.js'
import type { Note } from '../src/schema.js'
import { placeNoteId } from '../src/work-map.js'

const now = new Date('2026-10-08T12:00:00Z')
const place = (host: string, overrides: Partial<WorkPlace> = {}): WorkPlace => ({
  host, entry: `https://${host}/`, title: 'Review requests', pages: [], days: 5, lastSeen: '2026-10-08', bookmarks: [], managed: false, work: true, ...overrides,
})
const map = (...places: WorkPlace[]): WorkMap => ({ builtAt: now.toISOString(), windowDays: 90, places })
const task = (goal: string, overrides: Partial<Playbook> = {}): Playbook => ({ goal, urls: [], method: [], at: '2026-10-07T10:00:00Z', count: 1, ...overrides })
const question = (source: string, text = 'Which result should I prepare next time?') => ({ source, topic: 'outputs', question: text, basis: 'A previous completed task', options: ['A short summary', 'The full report'] })
const note = (id: string, body: string, front: Partial<Note['front']> = {}): Note => ({
  front: { id, type: 'note', status: 'current', supersedes: [], derived_from: [], decay: 'slow', timeline: 'ignore', created: now.toISOString(), updated: now.toISOString(), ...front }, body,
})

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
  const crowded = selectInterviewEvidence({ now, playbooks: Array.from({ length: 15 }, (_, i) => task(`Completed task ${i}`)), guide: '## Recurring work\n- Review the annual renewal.' })
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

it('handles weakly validated map fields without turning unstructured notes into work', () => {
  expect(selectInterviewEvidence({ map: { places: null } as unknown as WorkMap, guide: null as unknown as string }).sources).toEqual([])
  const malformed = map(null as unknown as WorkPlace, place('empty.example', { title: null as unknown as string, purpose: null as unknown as string }), place('valid.example', { bookmarks: null as unknown as string[] }))
  expect(selectInterviewEvidence({ now, map: malformed }).sources.map(one => one.grounding.hosts![0])).toEqual(['valid.example'])
  const manual = selectInterviewEvidence({ guide: '## Important work\nAnnual renewals need careful review even though they are rare.' })
  expect(manual.sources).toEqual([])
  expect(manual.guide).toContain('Annual renewals')
  expect(selectInterviewEvidence({ guide: 'I prepare the annual renewal.' }).sources).toEqual([])
  const long = selectInterviewEvidence({ guide: `## Recurring work\n- ${'A recurring task. '.repeat(2000)}` })
  expect(long.guide!.length).toBeLessThanOrEqual(12000)
  expect(long.sources[0]!.grounding.guideStatement!.length).toBeLessThanOrEqual(400)
})

it('keeps known rules as constraints, not new question sources', () => {
  const guide = '## Rules\n- Do not share until approved.\n## People\n- Send the finished report to the team lead.\n## Outputs\n- A one-page PDF.\n## Where things are\n- The shared library.\n## Terms (use exactly)\n- Preserve the original ID.\n## Examples\n- Use last month\'s approved report.'
  const onlyRules = selectInterviewEvidence({ now, guide })
  expect(onlyRules.sources).toEqual([])
  expect(parseInterviewQuestions(JSON.stringify({ questions: [question(`guide-${'a'.repeat(24)}`)] }), onlyRules)).toEqual([])
  const withTask = selectInterviewEvidence({ now, guide, playbooks: [task('Prepare the monthly report')] })
  expect(withTask.sources.map(one => one.kind)).toEqual(['task'])
  const prompt = interviewPrompt(withTask)
  expect(prompt).toContain('Do not share until approved.')
  expect(prompt).toContain('Send the finished report to the team lead.')
  expect(prompt).toContain('Never reopen or expand settled recipients')
  expect(prompt).toContain('If the guide already answers it, skip')
})

it('allows only eligible source IDs, one concise question per source, and no path-heavy response', () => {
  const evidence = selectInterviewEvidence({ now, playbooks: [task('Prepare the review'), task('Review request exceptions')], guide: '## Recurring work\n- Prepare an annual renewal.' })
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

it('uses Cosmos only as context for independently eligible work', () => {
  const notes = [note('n-summary', 'I am probably responsible for all renewals at https://work.example/private')]
  const unrelated = selectInterviewEvidence({ now, notes, map: map(place('work.example', { days: 0, bookmarks: ['Company tools'], managed: true })) })
  expect(unrelated.sources).toEqual([])
  expect(unrelated.context).toBeUndefined()
  const evidence = selectInterviewEvidence({ now, notes, map: map(place('work.example')) })
  expect(evidence.sources).toHaveLength(1)
  expect(evidence.context).toEqual([{
    source: evidence.sources[0]!.id, note: 'n-summary', updated: now.toISOString(), relation: 'host', provenance: 'observed-reference',
    excerpt: 'I am probably responsible for all renewals at work.example',
  }])
  const rejected = selectInterviewEvidence({ now, notes, map: map(place('work.example')), excludedIds: [evidence.sources[0]!.id] })
  expect(rejected.context).toBeUndefined()
})

it('matches exact parsed hosts or explicit task references, never repeated task words', () => {
  const playbooks = [task('Review requests', { urls: ['https://work.example/reviews'] })]
  const source = selectInterviewEvidence({ now, playbooks }).sources[0]!.id
  const evidence = selectInterviewEvidence({ now, playbooks, notes: [
    note('n-same-title', 'Review requests'),
    note('n-substring', 'https://work.example.attacker.test/private https://other.example/work.example'),
    note('n-credentials', 'https://password:secret@work.example/private'),
    note('n-explicit-task', 'Use the original request ID; approval status is unknown.', { source }),
    note('n-source-url', 'Keep unresolved discrepancies visible.', { source: 'https://work.example/reviews?token=hidden' }),
  ] })
  expect(evidence.context?.map(one => one.note)).toEqual(['n-explicit-task', 'n-source-url'])
  expect(evidence.context?.map(one => one.relation)).toEqual(['task', 'host'])
  expect(evidence.context?.[0]?.excerpt).toContain('unknown')
})

it('takes one grounded Cosmos link, not unrelated or recursive neighbors', () => {
  const anchor = placeNoteId('work.example')
  const evidence = selectInterviewEvidence({ now, map: map(place('work.example')), notes: [
    note(anchor, 'Review work here.', { type: 'place' }),
    note('n-linked', 'A draft normally includes unresolved cases.', { derived_from: [anchor] }),
    note('n-second-hop', 'Unrelated team policy.', { derived_from: ['n-linked'] }),
    note('n-unrelated', 'A report for another team.'),
  ] })
  expect(evidence.context?.map(one => one.note)).toEqual([anchor, 'n-linked'])
  expect(evidence.context?.[1]).toMatchObject({ relation: 'link', provenance: 'inferred-link' })
  expect(interviewPrompt(evidence)).not.toContain('Unrelated team policy')
})

it('does not carry retired, disputed, stale or invalid-dated Cosmos notes', () => {
  const body = 'Use https://work.example/reviews'
  const evidence = selectInterviewEvidence({ now, map: map(place('work.example')), notes: [
    ...(['superseded', 'archived', 'disputed', 'draft'] as const).map(status => note(`n-${status}`, body, { status })),
    note('n-expired', body, { verified_until: '2026-10-01T00:00:00Z' }),
    note('n-old', body, { created: '2025-01-01T00:00:00Z' }),
    note('n-future', body, { updated: '2027-01-01T00:00:00Z' }),
    note('n-invalid', body, { updated: 'unknown' }),
    note('n-current', body),
  ] })
  expect(evidence.context?.map(one => one.note)).toEqual(['n-current'])
})

it('bounds Cosmos context and sanitizes its paths, URL secrets and labelled credentials', () => {
  const places = Array.from({ length: 8 }, (_, i) => place(`work${i}.example`))
  const notes = places.flatMap((one, i) => Array.from({ length: 4 }, (_, j) => note(`n-${i}-${j}`, `Review at https://${one.host}/private?token=secret#secret. From "C:\\Team Files\\Review.xlsx" and /home/user/report.csv. password: hidden123. ${'Useful detail. '.repeat(100)}`)))
  const evidence = selectInterviewEvidence({ now, notes, map: map(...places) })
  expect(evidence.context).toHaveLength(6)
  for (const source of evidence.sources) expect(evidence.context!.filter(one => one.source === source.id).length).toBeLessThanOrEqual(2)
  expect(evidence.context!.every(one => one.excerpt.length <= 600)).toBe(true)
  const prompt = interviewPrompt(evidence)
  for (const text of ['?token=', '#secret', 'Team Files', 'Review.xlsx', '/home/user', 'hidden123']) expect(prompt).not.toContain(text)
})
