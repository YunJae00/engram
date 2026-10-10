import { afterEach, expect, it, vi } from 'vitest'
import { runToolSession, SESSION_STALL_MS } from '../src/agent-session.js'
import type { Engine, ToolSessionJob } from '../src/engine/types.js'
import { pageTools } from '../src/comet-page-tools.js'
import { pageReport } from '../src/page-report.js'
import type { WebCourier } from '../src/errand.js'
import { successfulTurnSteps } from '../src/routine-record.js'

afterEach(() => { vi.useRealTimers() })

it.each([true, false])('counts native tool activity without treating it as verified evidence (success=%s)', async ok => {
  vi.useFakeTimers()
  let job!: ToolSessionJob
  let finish!: (result: { answer: string }) => void
  const engine = { id: 'claude', runTools: (next: ToolSessionJob) => { job = next; return new Promise(resolve => { finish = resolve }) } } as unknown as Engine
  const onCall = vi.fn(), onResult = vi.fn()
  const pending = runToolSession({ engine, workdir: process.cwd(), tools: [] } as never, 'Read', {
    native: { cwd: process.cwd(), readRoots: [], decide: async () => ({ behavior: 'allow' }), onCall, onResult },
  })
  await vi.advanceTimersByTimeAsync(SESSION_STALL_MS - 10_000)
  job.native!.onCall!('Bash', { command: 'python report.py' })
  await vi.advanceTimersByTimeAsync(SESSION_STALL_MS + 10_000)
  expect(job.signal?.aborted).toBe(false)
  job.native!.onResult!('Bash', ok)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(job.signal?.aborted).toBe(false)
  expect(onCall).toHaveBeenCalledWith('Bash', { command: 'python report.py' })
  expect(onResult).toHaveBeenCalledWith('Bash', ok)
  finish({ answer: 'Read' })
  const result = await pending
  expect(result.steps).toEqual([])
  expect(result.incomplete).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it('counts model tokens without a UI subscriber and does not interrupt an active tool', async () => {
  vi.useFakeTimers()
  let job!: ToolSessionJob
  let finish!: (result: { answer: string }) => void
  let finishTool!: () => void
  const engine = { id: 'claude', runTools: (next: ToolSessionJob) => { job = next; return new Promise(resolve => { finish = resolve }) } } as unknown as Engine
  const tool = { name: 'read_open_page', description: 'read', run: () => new Promise<string>(resolve => { finishTool = () => resolve('page') }) }
  const pending = runToolSession({ engine, workdir: process.cwd(), tools: [tool] } as never, 'Read')
  await vi.advanceTimersByTimeAsync(SESSION_STALL_MS - 10_000)
  job.onToken?.('Still working')
  await vi.advanceTimersByTimeAsync(20_000)
  expect(job.signal?.aborted).toBe(false)
  const reading = job.tools[0]!.run({})
  await vi.advanceTimersByTimeAsync(SESSION_STALL_MS + 10_000)
  expect(job.signal?.aborted).toBe(false)
  finishTool(); await reading
  finish({ answer: 'Read' })
  expect((await pending).incomplete).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it('ends a turn whose model has gone silent, keeping it unfinished so the task can go on', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined
  const engine = {
    id: 'claude', desktopToolIsolation: true,
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run() { yield { type: 'result', text: '' } },
    runTools: (job: ToolSessionJob) => new Promise(resolve => {
      signal = job.signal
      void job.tools[0]!.run({})
      job.signal?.addEventListener('abort', () => resolve({ answer: '', error: 'canceled' }), { once: true })
    }),
  } as unknown as Engine
  const tools = [{ name: 'file_create_copy', description: 'save', run: async () => JSON.stringify({ markdownLink: '[Draft](engram-artifact:draft.txt)' }) }]
  const pending = runToolSession({ engine, workdir: process.cwd(), tools } as never, 'Prepare a draft')
  await vi.advanceTimersByTimeAsync(SESSION_STALL_MS - 10_000)
  expect(signal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(20_000)
  const result = await pending
  expect(signal?.aborted).toBe(true)
  expect(result.incomplete).toContain('stopped responding')
  expect(result.answer).toContain('Not verified as complete')
  expect(result.answer).toContain('[Draft](engram-artifact:draft.txt)')
  expect(result.steps).toHaveLength(1)
})

it('counts host-only progress without visible tokens, but still stops when that progress goes silent', async () => {
  vi.useFakeTimers()
  let job!: ToolSessionJob
  const onToken = vi.fn()
  const engine = { id: 'claude', runTools: (next: ToolSessionJob) => new Promise(resolve => {
    job = next
    job.signal?.addEventListener('abort', () => resolve({ answer: '', error: 'canceled' }), { once: true })
  }) } as unknown as Engine
  const pending = runToolSession({ engine, workdir: process.cwd(), tools: [] } as never, 'Read', { onToken })
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(SESSION_STALL_MS - 10_000)
    job.onProgress?.()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(job.signal?.aborted).toBe(false)
  }
  expect(onToken).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(SESSION_STALL_MS + 10_000)
  const result = await pending
  expect(job.signal?.aborted).toBe(true)
  expect(result.incomplete).toContain('stopped responding')
  expect(vi.getTimerCount()).toBe(0)
})

it('refuses a page move made a third time after it came back the same twice, and lets a different move through', async () => {
  let presses = 0
  const said: string[] = []
  const press = { name: 'press', description: 'press', argsSchema: {}, run: async () => { presses++; return `Observation page-1/0/${presses}; control numbers belong only to this reading.\npage "Form": nothing changed\n#3 [button] Save` } }
  const engine = {
    id: 'claude', desktopToolIsolation: true,
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run() { yield { type: 'result', text: '' } },
    runTools: async (job: ToolSessionJob) => {
      const call = job.tools.find(tool => tool.name === 'press')!
      for (let i = 0; i < 3; i++) said.push(String(await call.run({ target: '#3' })))
      said.push(String(await call.run({ target: 'Cancel' })))
      return { answer: 'done' }
    },
  } as unknown as Engine
  await runToolSession({ engine, workdir: process.cwd(), tools: [press] } as never, 'Save the form')
  expect(presses).toBe(3)
  expect(said[2]).toContain('has already been made 2 times with the same result')
  expect(said[3]).toContain('nothing changed')
})

function pageSession(courier: WebCourier, act: (job: ToolSessionJob) => Promise<void>, maxCalls?: number) {
  const engine = { runTools: async (job: ToolSessionJob) => { await act(job); return { answer: 'done' } } } as unknown as Engine
  const tools = [...pageTools({}, courier), {
    name: 'read_open_page', description: 'read', run: async () => pageReport(await courier.readOpen!()),
  }]
  return runToolSession({ engine, workdir: process.cwd(), tools } as never, 'Use the page', { maxCalls })
}

it('allows opening the same menu again after closing it', async () => {
  let opened = false, revision = 0
  const press = vi.fn(async () => { opened = true; return { ok: true, changed: true } })
  const courier: WebCourier = {
    fetchPage: async () => { throw new Error('unexpected navigation') },
    readOpen: async () => ({ url: 'https://example.test', title: 'Menu', text: opened ? 'Details open' : 'Details closed',
      controls: ['#1 [button] Details'], observation: { page: 'page-1', document: 0, revision: ++revision } }),
    press,
    pressKey: async () => { opened = false; return { ok: true, changed: true } },
  }
  await pageSession(courier, async job => {
    const open = job.tools.find(tool => tool.name === 'press')!
    const close = job.tools.find(tool => tool.name === 'press_key')!
    for (let i = 0; i < 2; i++) {
      await open.run({ target: 'Details' })
      await close.run({ key: 'Escape' })
    }
    await open.run({ target: 'Details' })
  })
  expect(press).toHaveBeenCalledTimes(3)
  expect(opened).toBe(true)
})

it('allows retrying Save after correcting the validation fault', async () => {
  let name = '', revision = 0
  const press = vi.fn(async () => ({ ok: true, changed: false }))
  const courier: WebCourier = {
    fetchPage: async () => { throw new Error('unexpected navigation') },
    readOpen: async () => ({ url: 'https://example.test/form', title: 'Form', text: `Name: ${name}`,
      faults: name ? [] : ['Name required'], controls: ['#1 [textbox] Name', '#2 [button] Save'],
      observation: { page: 'page-1', document: 0, revision: ++revision } }),
    press,
    typeText: async (_target, text) => { name = text; return { ok: true } },
  }
  await pageSession(courier, async job => {
    const save = job.tools.find(tool => tool.name === 'press')!
    await save.run({ target: 'Save' })
    await save.run({ target: 'Save' })
    await job.tools.find(tool => tool.name === 'type_text')!.run({ target: 'Name', text: 'Alice', enter: false })
    await save.run({ target: 'Save' })
  })
  expect(name).toBe('Alice')
  expect(press).toHaveBeenCalledTimes(3)
})

it('retains the repeat guard when only the observation revision changes on a reread', async () => {
  let revision = 0
  const press = vi.fn(async () => ({ ok: true, changed: false }))
  const courier: WebCourier = {
    fetchPage: async () => { throw new Error('unexpected navigation') },
    readOpen: async () => ({ url: 'https://example.test', title: 'Menu', text: 'Unchanged page',
      controls: ['#1 [button] Details'], observation: { page: 'page-1', document: 0, revision: ++revision } }),
    press,
  }
  let refused = ''
  await pageSession(courier, async job => {
    const open = job.tools.find(tool => tool.name === 'press')!
    const read = job.tools.find(tool => tool.name === 'read_open_page')!
    for (let i = 0; i < 2; i++) {
      await open.run({ target: 'Details' })
      await read.run({})
    }
    refused = String(await open.run({ target: 'Details' }))
  })
  expect(press).toHaveBeenCalledTimes(2)
  expect(refused).toContain('has already been made 2 times with the same result')
})

it('counts a refused repeat toward the call budget and reports the turn unfinished', async () => {
  const press = vi.fn(async () => ({ ok: true, changed: false }))
  const courier: WebCourier = {
    fetchPage: async () => { throw new Error('unexpected navigation') },
    readOpen: async () => ({ url: 'https://example.test', title: 'Menu', text: 'Unchanged page', controls: ['#1 [button] Details'] }),
    press,
  }
  const said: string[] = []
  const result = await pageSession(courier, async job => {
    const open = job.tools.find(tool => tool.name === 'press')!
    for (let i = 0; i < 4; i++) said.push(String(await open.run({ target: 'Details' })))
  }, 3)
  expect(press).toHaveBeenCalledTimes(2)
  expect(said[2]).toContain('has already been made 2 times with the same result')
  expect(said[3]).toContain('No more calls this turn')
  expect(result.steps).toHaveLength(3)
  expect(result.steps[2]!.observation).toContain('has already been made 2 times with the same result')
  expect(successfulTurnSteps(result.steps)).toEqual([])
  expect(result.stopped).toBe('calls')
  expect(result.answer).toContain('Not verified as complete')
})

it('stops repeated unreadable-page actions across changed key arguments and intervening screenshots', async () => {
  const failure = new Error('The page has not exposed readable content after waiting.')
  const pressKey = vi.fn(async () => { throw failure })
  const readOpen = vi.fn(async () => { throw failure })
  const said: string[] = []
  await pageSession({ fetchPage: readOpen, readOpen, pressKey, look: async () => ({ data: 'image', mimeType: 'image/jpeg' }) }, async job => {
    const call = (name: string, args: Record<string, unknown>) => job.tools.find(tool => tool.name === name)!.run(args)
    for (const key of ['Escape', 'Tab', 'Space']) {
      said.push(String(await call('press_key', { key })))
      await call('look', {})
    }
    for (const find of ['Hours', 'Access', 'Schedule']) said.push(String(await call('read_open_page', { find })))
  })
  expect(pressKey).toHaveBeenCalledTimes(2)
  expect(readOpen).toHaveBeenCalledTimes(2)
  expect(said[2]).toContain('was not run again')
  expect(said[5]).toContain('was not run again')
})
