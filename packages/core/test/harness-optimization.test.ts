import { expect, it, vi } from 'vitest'
import { pageDelta } from '../src/page-delta.js'
import { pageReport } from '../src/page-report.js'
import { pageTools } from '../src/comet-page-tools.js'
import { browserReadBatch } from '../src/browser-read-batch.js'
import { measuredCourier, type HarnessMetric } from '../src/harness-metrics.js'
import { runToolSession } from '../src/agent-session.js'
import type { WebPage } from '../src/errand.js'
import type { Engine, EngineCwd, ToolSessionJob } from '../src/engine/types.js'

function page(revision = 1): WebPage {
  return { url: 'https://example.com/', title: 'Report', text: Array.from({ length: 24 }, (_, n) => `Row ${n}: ${'Stable observed content. '.repeat(3)}`).join('\n'), controls: ['#1 [button] Next'], observation: { page: 'one', document: 1, revision } }
}

it('compacts changed body lines, preserves current controls, and periodically restores a full base', () => {
  const report = pageDelta()
  const first = page()
  expect(report(first)).toBe(pageReport(first))
  for (let revision = 2; revision <= 4; revision++) {
    const next = { ...page(revision), text: first.text.replace('Row 9:', `Row 9 value ${revision}:`), controls: ['#1 [button] Previous', '#2 [button] Next'] }
    const compact = report(next)!
    expect(compact).toContain('delta from')
    expect(compact).toContain(`Row 9 value ${revision}:`)
    expect(compact).toContain('#2 [button] Next')
    expect(compact.length).toBeLessThan(pageReport(next).length * 0.7)
  }
  expect(report(page(5))).toBe(pageReport(page(5)))
})

it('never compacts across tabs, navigation, resets, uncertainty or truncated bodies', () => {
  for (const next of [
    { ...page(2), observation: { page: 'two', document: 1, revision: 2 } },
    { ...page(2), observation: { page: 'one', document: 2, revision: 2 } },
    { ...page(2), url: 'https://example.com/other' },
    { ...page(2), dialog: 'Confirm submission' },
    { ...page(2), faults: ['Invalid date'] },
    { ...page(2), wall: 'login' as const },
    { ...page(2), text: 'Large content\n'.repeat(1000) },
    { ...page(2), observation: undefined },
  ]) {
    const report = pageDelta()
    report(page())
    expect(report(next)).toBe(pageReport(next))
  }
  const report = pageDelta()
  report(page())
  report()
  expect(report(page(2))).toBe(pageReport(page(2)))
})

it('reads every action afresh and keeps full evidence while sending compact observations in a session', async () => {
  let revision = 0
  const readOpen = vi.fn(async () => page(++revision))
  const tools = pageTools({}, { fetchPage: async () => page(), readOpen, scroll: async () => ({ ok: true, changed: true }) })
  tools.push({ name: 'open_page', description: '', argsSchema: {}, run: async () => 'unused' })
  const sent: string[] = [], metrics: HarnessMetric[] = []
  const engine = { id: 'mock', runTools: async (job: ToolSessionJob) => {
    const scroll = job.tools.find(tool => tool.name === 'scroll')!
    for (let i = 0; i < 3; i++) {
      if (i === 2) job.onContextReset?.()
      sent.push(String(await scroll.run({ to: 'down' })))
    }
    return { answer: 'Observed' }
  } } as Engine
  const result = await runToolSession({ engine, tools, workdir: '.' as EngineCwd }, 'Read the report', { onMetric: value => metrics.push(value) })
  expect(readOpen).toHaveBeenCalledTimes(3)
  expect(sent[1]).toContain('delta from')
  expect(sent[2]).not.toContain('delta from')
  expect(result.steps[1]!.observation).toContain('Row 23:')
  expect(result.steps[1]!.observation).not.toContain('delta from')
  expect(metrics.some(value => value.kind === 'observation' && value.sentChars! < value.fullChars!)).toBe(true)
  sent.length = 0
  await runToolSession({ engine, tools, workdir: '.' as EngineCwd }, 'Read again', { compactObservations: false })
  expect(sent.every(value => !value.includes('delta from'))).toBe(true)
})

it('validates every batch member before navigating and preserves partial results on an unexpected page', async () => {
  const fetchPage = vi.fn(async (url: string) => ({ ...page(), url, text: url.endsWith('/two') ? 'Login required' : 'Ready. Result one.' }))
  const tool = browserReadBatch({ fetchPage })
  await expect(tool.run({ pages: [{ url: 'https://example.com/one', ready: 'Ready' }, { url: 'javascript:alert(1)', ready: 'Ready' }] }, { task: 'Read' })).rejects.toThrow('HTTP')
  expect(fetchPage).not.toHaveBeenCalled()
  const result = await tool.run({ pages: ['one', 'two', 'three'].map(name => ({ url: `https://example.com/${name}`, ready: 'Ready' })) }, { task: 'Read' })
  expect(fetchPage).toHaveBeenCalledTimes(2)
  expect(result).toContain('Batch stopped: 1/3')
  expect(result).toContain('Result one.')
})

it('batch cancellation stops unfinished reads and metrics contain no content or URLs', async () => {
  const controller = new AbortController(), metrics: HarnessMetric[] = []
  const fetchPage = vi.fn(async (url: string) => { controller.abort(new Error('canceled')); return { ...page(), url } })
  const courier = measuredCourier({ fetchPage }, value => metrics.push(value))
  const tool = browserReadBatch(courier, undefined, value => metrics.push(value))
  await expect(tool.run({ pages: [{ url: 'https://example.com/private', ready: 'Row' }] }, { task: 'Read', signal: controller.signal })).rejects.toThrow('canceled')
  expect(fetchPage).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(metrics)).not.toMatch(/example|private|Row/)
  expect(metrics).toContainEqual({ kind: 'batch', completed: 0, requested: 1 })
})

it('charges a read batch per page against the existing session budget', async () => {
  const fetchPage = vi.fn(async (url: string) => ({ ...page(), url }))
  const batch = browserReadBatch({ fetchPage })
  const engine = { id: 'mock', runTools: async (job: ToolSessionJob) => {
    const tool = job.tools.find(one => one.name === 'read_pages')!
    const result = await tool.run({ pages: [1, 2, 3].map(n => ({ url: `https://example.com/${n}`, ready: 'Row' })) })
    expect(result).toContain('No more calls')
    return { answer: 'Unfinished' }
  } } as Engine
  const result = await runToolSession({ engine, tools: [batch], workdir: '.' as EngineCwd }, 'Read pages', { maxCalls: 2 })
  expect(fetchPage).not.toHaveBeenCalled()
  expect(result.stopped).toBe('calls')
})

it('does not accept a model completion claim after a stopped batch', async () => {
  const batch = browserReadBatch({ fetchPage: async url => ({ ...page(), url, wall: 'login' }) })
  const engine = { id: 'mock', runTools: async (job: ToolSessionJob) => {
    await job.tools[0]!.run({ pages: [{ url: 'https://example.com/', ready: 'Row' }] })
    return { answer: 'Everything is complete' }
  } } as Engine
  const result = await runToolSession({ engine, tools: [batch], workdir: '.' as EngineCwd }, 'Read pages')
  expect(result.incomplete).toContain('batch stopped')
  expect(result.answer).toContain('Not verified as complete')
})
