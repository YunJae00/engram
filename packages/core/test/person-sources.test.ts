import { expect, it } from 'vitest'
import { INTERVIEW_SOURCE_ID, personSources } from '../src/interview-evidence.js'
import { interviewPrompt, parseInterviewQuestions } from '../src/work-guide.js'

it('keeps personal question sources stable and excludes dismissed topics', () => {
  const sources = personSources()
  expect(sources).toHaveLength(4)
  expect(new Set(sources.map(source => source.id)).size).toBe(4)
  expect(personSources()).toEqual(sources)
  for (const source of sources) {
    expect(source.id).toMatch(INTERVIEW_SOURCE_ID)
    expect(source.kind).toBe('person')
    expect(source.grounding).toEqual({})
  }
  expect(personSources([sources[0]!.id])).toEqual(sources.slice(1))
})

it('accepts personal questions without work traces and rejects invented sources', () => {
  const evidence = { sources: personSources() }
  const question = { source: evidence.sources[0]!.id, topic: 'outputs', question: 'How long should answers be?', basis: 'Your preference', options: ['Short', 'Detailed'] }
  expect(parseInterviewQuestions(JSON.stringify({ questions: [question] }), evidence)).toEqual([question])
  expect(parseInterviewQuestions(JSON.stringify({ questions: [{ ...question, source: 'person-000000000000000000000000' }] }), evidence)).toEqual([])
  expect(interviewPrompt(evidence)).toContain('unless the current guide already answers it')
})
