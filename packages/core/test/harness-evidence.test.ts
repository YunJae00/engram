import { expect, it } from 'vitest'
import { browserReadBatch } from '../src/browser-read-batch.js'
import { evidenceFault } from '../src/work-evidence.js'

it.each([
  { url: 'https://www.example.test/report/' },
  { url: 'https://reports.test/final', requestedUrl: 'https://example.test/report' },
  { url: 'https://example.test/report', dialog: 'Cookie preferences' },
])('reads a ready page after normalization, observed redirects or a dialog: %j', async destination => {
  const tool = browserReadBatch({ fetchPage: async () => ({ title: 'Report', text: 'Ready body', ...destination }) })
  expect(await tool.run({ pages: [{ url: 'https://example.test/report', ready: 'Ready body' }] }, { task: 'Read' })).toContain('Batch read: 1/1')
})

it('does not accept an unrelated page or a login wall as a redirect', async () => {
  for (const destination of [{ url: 'https://unrelated.test' }, { url: 'https://example.test/report', wall: 'login' as const }]) {
    const tool = browserReadBatch({ fetchPage: async () => ({ title: 'Report', text: 'Ready body', ...destination }) })
    expect(await tool.run({ pages: [{ url: 'https://example.test/report', ready: 'Ready body' }] }, { task: 'Read' })).toContain('Batch stopped: 0/1')
  }
})

it('replaces failed checks of the same purpose while preserving other failures', () => {
  const step = (id: string, status: string, present: string) => ({ tool: 'verify', args: { id, url: 'https://example.test', ready: 'Ready', present: [present] }, observation: JSON.stringify({ verification: { status } }) })
  const corrected = [step('total', 'failed', 'Old total'), step('total', 'passed', 'Correct total')]
  expect(evidenceFault(corrected)).toBeUndefined()
  expect(evidenceFault([step('recipient', 'failed', 'Recipient'), ...corrected])).toBeDefined()
})

it('does not treat a dialog-only page as a readable document', async () => {
  const tool = browserReadBatch({ fetchPage: async url => ({ url, title: 'Ready', text: '', dialog: 'Please confirm' }) })
  expect(await tool.run({ pages: [{ url: 'https://example.test', ready: 'Ready' }] }, { task: 'Read' })).toContain('Batch stopped: 0/1')
})
