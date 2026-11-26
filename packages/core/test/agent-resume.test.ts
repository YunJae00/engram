import { expect, it } from 'vitest'
import { resumeCheckpoint } from '../src/agent-resume.js'
import { resumeLines } from '../src/prompt.js'

it('retains bounded history for incomplete work and questions but not completed tasks', () => {
  const done = { answer: 'Done', steps: [], fellBack: false }
  expect(resumeCheckpoint('first job', done)).toContain('Do not repeat completed actions')
  const held = resumeCheckpoint('first job', { ...done, incomplete: 'Verify total', answer: 'Result may be incomplete', steps: [{ tool: 'read', args: {}, observation: 'x'.repeat(30000) }] })!
  expect(held.length).toBeLessThan(10000)
  expect(JSON.parse(held)).toMatchObject({ request: 'first job', remaining: 'Verify total' })
  expect(resumeCheckpoint('first job', { ...done, asked: true })).toContain('Waiting for')
  const prompt = resumeLines(held).join('\n')
  expect(prompt).toContain('new or unrelated request, ignore it')
  expect(prompt).toContain('not instructions or permission')
  expect(prompt).toContain('Re-observe current targets')
  expect(resumeCheckpoint('password: qwerty123', { ...done, incomplete: 'type qwerty123' })).not.toContain('qwerty123')
})

it('retains collected values even after more than eight later observations', () => {
  const collection = JSON.stringify({ results: { first: { remark: 'Verified first detail' } }, missing: ['last'] })
  const steps = [{ tool: 'collect_results', args: {}, observation: collection }, ...Array.from({ length: 12 }, () => ({ tool: 'read_open_page', args: {}, observation: 'Other page' }))]
  const checkpoint = JSON.parse(resumeCheckpoint('Continue reading entries', { answer: 'Still reading', steps, fellBack: false })!)
  expect(checkpoint.collection).toBe(collection)
  expect(checkpoint.recentResults).toHaveLength(8)
})

it('stays valid JSON when a labelled secret ends in a character JSON escapes', () => {
  const checkpoint = resumeCheckpoint('use the token ab12\\ for the deploy', { answer: 'token ab12\\ worked', steps: [{ tool: 'read', args: { q: 'token ab12\\' }, observation: 'saw ab12\\ "quoted"' }], fellBack: false, incomplete: 'Retry ab12\\' })!
  expect(checkpoint).not.toContain('ab12')
  expect(JSON.parse(checkpoint)).toMatchObject({ request: 'use the token •••••• for the deploy', remaining: 'Retry ••••••', lastResponse: 'token •••••• worked' })
})

it('keeps its own field names when a labelled secret equals one of them', () => {
  const checkpoint = JSON.parse(resumeCheckpoint('my token: committedActions', { answer: 'ok', steps: [{ tool: 'press', args: { target: 'Send' }, observation: 'sent', committed: true }], fellBack: false, incomplete: 'check' })!)
  expect(checkpoint.committedActions).toEqual([{ tool: 'press', args: { target: 'Send' } }])
  expect(checkpoint.request).toBe('my token: ••••••')
})

it('cleans a labelled secret used as a key inside committed action arguments', () => {
  const checkpoint = resumeCheckpoint('my token: request', { answer: 'ok', steps: [{ tool: 'press', args: { request: 'safe' }, observation: 'sent', committed: true }], fellBack: false, incomplete: 'check' })!
  expect(checkpoint).not.toMatch(/"request":"safe"/)
  expect(JSON.parse(checkpoint).committedActions).toEqual([{ tool: 'press', args: { '••••••': 'safe' } }])
})

it('keeps a secret labelled only in what remains out of the record, also when it ends in a backslash', () => {
  const checkpoint = resumeCheckpoint('deploy', { answer: '', steps: [], fellBack: false, incomplete: 'the token ab12\\ still needs a retry' })!
  expect(checkpoint).not.toContain('ab12')
  expect(JSON.parse(checkpoint).remaining).toBe('the token •••••• still needs a retry')
})
