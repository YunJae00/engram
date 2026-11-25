import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { traced, type TraceRecord } from '../src/engine/trace.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'

const hash16 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
const SYSTEM = 'You keep a greenhouse journal.'

type Greenhouse = Engine & { vents: number; openVents(): number }

function greenhouse(steps: { tool: string; args: Record<string, unknown> }[]): { engine: Greenhouse; seen: unknown[] } {
  const seen: unknown[] = []
  const engine: Greenhouse = {
    id: 'mock',
    vents: 0,
    openVents() { return ++this.vents },
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run() { yield { type: 'result', text: 'not used' } },
    async runTools(job: ToolSessionJob): Promise<ToolSessionResult> {
      job.onToken?.('Tomatoes ')
      job.onUsage?.(310)
      for (const step of steps) seen.push(await job.tools.find(tool => tool.name === step.tool)!.run(step.args))
      job.onUsage?.(55)
      job.onToken?.('need water.')
      return { answer: 'Tomatoes need water.', note: 'read two beds' }
    },
    quick: async prompt => `a line about ${prompt}`,
  }
  return { engine, seen }
}

function job(extra: Partial<ToolSessionJob> = {}): ToolSessionJob {
  return {
    workdir: '/fixture' as EngineCwd,
    system: SYSTEM,
    opening: 'Yesterday the basil wilted.',
    prompt: 'Which bed is driest?',
    sessionKey: 'garden-room',
    modelHint: 'smart',
    effort: 'medium',
    maxCalls: 4,
    tools: [
      { name: 'soil', description: 'Reads soil moisture for a bed', argsSchema: { type: 'object', properties: { bed: { type: 'string' } } }, run: async args => `bed ${String(args['bed'])}: 12%` },
      { name: 'camera', description: 'Looks at the leaves', argsSchema: { type: 'object' }, run: async () => ({ text: 'curling', image: { data: 'leafpix', mimeType: 'image/png' } }) },
      { name: 'thermometer', description: 'Reads the air', argsSchema: { type: 'object' }, run: async () => { throw new Error('probe unplugged') } },
    ],
    ...extra,
  }
}

const jobRecord = (records: TraceRecord[]) => {
  expect(records).toHaveLength(1)
  const record = records[0]!
  if (record.kind !== 'job') throw new Error('not a job record')
  return record
}

it('records one job with both tool calls in order, their times, result hashes, the system hash and the menu', async () => {
  const records: TraceRecord[] = []
  const { engine } = greenhouse([{ tool: 'soil', args: { bed: 'north' } }, { tool: 'camera', args: { zoom: 2 } }])
  await traced(engine, record => records.push(record)).runTools!(job({ onToken: () => undefined, onUsage: () => undefined }))
  const record = jobRecord(records)
  expect(record).toMatchObject({
    sessionKey: 'garden-room', modelHint: 'smart', effort: 'medium', maxCalls: 4,
    system: SYSTEM, systemHash: hash16(SYSTEM), opening: 'Yesterday the basil wilted.', prompt: 'Which bed is driest?',
    usage: [310, 55], answer: 'Tomatoes need water.'.length, note: 'read two beds',
  })
  expect(record.menu).toEqual(job().tools.map(tool => ({ name: tool.name, description: tool.description.length, schema: JSON.stringify(tool.argsSchema).length })))
  expect(record.calls.map(({ name, args, length, hash, threw }) => ({ name, args, length, hash, threw }))).toEqual([
    { name: 'soil', args: { bed: 'north' }, length: 'bed north: 12%'.length, hash: hash16('bed north: 12%'), threw: false },
    { name: 'camera', args: { zoom: 2 }, length: 'curlingleafpix'.length, hash: hash16('curlingleafpix'), threw: false },
  ])
  expect(record.calls.every(call => Number.isInteger(call.ms) && call.ms >= 0)).toBe(true)
  expect(record.firstTokenMs).toBeGreaterThanOrEqual(0)
  expect(record.endMs).toBeGreaterThanOrEqual(record.firstTokenMs!)
  expect(Number.isNaN(Date.parse(record.at))).toBe(false)
})

it('marks a throwing tool as thrown and still hands the error to the caller', async () => {
  const records: TraceRecord[] = []
  const { engine } = greenhouse([{ tool: 'soil', args: { bed: 'south' } }, { tool: 'thermometer', args: {} }])
  await expect(traced(engine, record => records.push(record)).runTools!(job())).rejects.toThrow('probe unplugged')
  const record = jobRecord(records)
  expect(record.calls.map(call => [call.name, call.threw])).toEqual([['soil', false], ['thermometer', true]])
  expect(record.error).toBe('probe unplugged')
})

it('records one quick call', async () => {
  const records: TraceRecord[] = []
  const answer = await traced(greenhouse([]).engine, record => records.push(record)).quick!('frost tonight', { workdir: '/fixture', timeoutMs: 300 })
  expect(answer).toBe('a line about frost tonight')
  expect(records).toEqual([expect.objectContaining({ kind: 'quick', prompt: 'frost tonight', answer: answer.length })])
})

it('gives the caller the same answer, streamed text and tool results with or without the trace', async () => {
  const steps = [{ tool: 'soil', args: { bed: 'east' } }, { tool: 'camera', args: {} }]
  const watch = async (trace: boolean) => {
    const { engine, seen } = greenhouse(steps)
    const tokens: string[] = []
    const wrapped = trace ? traced(engine, () => undefined) : engine
    const result = await wrapped.runTools!(job({ onToken: text => tokens.push(text) }))
    return { result, tokens, seen }
  }
  expect(await watch(true)).toEqual(await watch(false))
})

it('returns the very same engine when no sink is given', () => {
  const { engine } = greenhouse([])
  expect(traced(engine)).toBe(engine)
})

it('keeps a method it does not record, and that method still acts on the engine', () => {
  const { engine } = greenhouse([])
  const wrapped = traced(engine, () => undefined)
  expect(wrapped.openVents()).toBe(1)
  expect(engine.vents).toBe(1)
})

it('hands the caller the answer even when the trace sink breaks while writing', async () => {
  const { engine } = greenhouse([{ tool: 'soil', args: { bed: 'west' } }])
  const wrapped = traced(engine, () => { throw new Error('ledger is full') })
  expect((await wrapped.runTools!(job())).answer).toBe('Tomatoes need water.')
  expect(await wrapped.quick!('hail warning', { workdir: '/fixture', timeoutMs: 300 })).toBe('a line about hail warning')
})

it('times the first token and keeps usage when the caller passes no stream or usage callbacks', async () => {
  const records: TraceRecord[] = []
  const { engine } = greenhouse([])
  await traced(engine, record => records.push(record)).runTools!(job())
  const record = jobRecord(records)
  expect(record.firstTokenMs).toBeGreaterThanOrEqual(0)
  expect(record.usage).toEqual([310, 55])
})
