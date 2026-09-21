import { expect, it, vi } from 'vitest'
import type { DevApproval, DevSession } from '../src/shared/developers.js'

const fake = vi.hoisted(() => ({ notify: vi.fn<(method: string, params: Record<string, unknown>) => void>(), request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(), calls: [] as { method: string; params: Record<string, unknown> }[], close: vi.fn() }))
vi.mock('../src/main/engine-cloud.js', () => ({ codexBinary: () => 'runtime', withHelpersOnPath: () => ({}) }))
vi.mock('../src/main/dev-rpc.js', () => ({ DevRpc: class {
  constructor(_binary: string, _options: unknown, notify: (method: string, params: Record<string, unknown>) => void, request: (method: string, params: Record<string, unknown>) => Promise<unknown>) { fake.notify.mockImplementation(notify); fake.request.mockImplementation(request); fake.calls = [] }
  async initialize() {}
  async send(method: string, params: Record<string, unknown>) { fake.calls.push({ method, params }); return method === 'skills/list' ? { data: [{ skills: [{ name: 'inspect', description: 'Inspect files', enabled: true }, { name: 'disabled', enabled: false }] }] } : method === 'turn/start' ? { turn: { id: 'turn' } } : { thread: { id: 'owned' } } }
  close() { fake.close() }
  async shutdown() { this.close() }
} }))
import { DevCodex } from '../src/main/dev-codex.js'
import { DevApprovals } from '../src/main/dev-approvals.js'

function setup(mode: DevSession['mode'] = 'review') {
  let approvals: DevApproval[] = []
  const gate = new DevApprovals(value => { approvals = value })
  const session: DevSession = { id: 'local', repoId: 'repo', provider: 'codex', model: '', mode, cwd: '.', title: 'Task', createdAt: 0, updatedAt: 0, state: 'idle', items: [], pending: [], usage: {} }
  const updates = { item: vi.fn(), usage: vi.fn(), finished: vi.fn() }
  const driver = new DevCodex(session, gate, updates)
  return { driver, gate, session, updates, approvals: () => approvals }
}

it('resumes without a full history response and retains command details on completion', async () => {
  const test = setup()
  test.session.runtimeId = 'existing'
  await test.driver.start()
  expect(fake.calls[0]).toMatchObject({ method: 'thread/resume', params: { excludeTurns: true } })
  fake.notify('item/started', { threadId: 'owned', item: { id: 'cmd', type: 'commandExecution', command: 'git status' } })
  fake.notify('item/commandExecution/outputDelta', { threadId: 'owned', itemId: 'cmd', delta: 'Checking' })
  expect(test.updates.item).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'git status\nChecking', status: 'running' }))
  fake.notify('item/completed', { threadId: 'owned', item: { id: 'cmd', type: 'commandExecution', aggregatedOutput: 'failed', exitCode: 1 } })
  expect(test.updates.item).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Command', activity: 'command', text: 'git status\nfailed', status: 'failed' }))
  fake.notify('item/started', { threadId: 'owned', item: { id: 'read', type: 'commandExecution', command: 'read file', commandActions: [{ type: 'read', path: 'src/main.ts' }] } })
  expect(test.updates.item).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Read · main.ts', activity: 'file' }))
  await test.driver.stop()
})

it('keeps review read-only until an explicit approval and rejects foreign requests', async () => {
  const test = setup()
  await test.driver.start()
  expect(fake.calls[0]?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'untrusted' })
  expect(await test.driver.commands()).toEqual([{ name: 'inspect', description: 'Inspect files', prompt: '$inspect ' }])
  await expect(fake.request('item/commandExecution/requestApproval', { threadId: 'foreign' })).rejects.toThrow('does not belong')
  const approval = fake.request('item/commandExecution/requestApproval', { threadId: 'owned', command: 'write command' })
  expect(test.approvals()).toHaveLength(1)
  test.gate.respond(test.approvals()[0]!.id, { decision: 'deny' })
  expect(await approval).toEqual({ decision: 'decline' })
  await test.driver.stop()
})

it('denies plan-mode permissions and cancels unanswered prompts on stop', async () => {
  const plan = setup('plan')
  await plan.driver.start()
  expect(await fake.request('item/fileChange/requestApproval', { threadId: 'owned' })).toEqual({ decision: 'decline' })
  await plan.driver.stop()
  const test = setup()
  await test.driver.start(); await test.driver.send('Inspect the fixture')
  await expect(fake.request('item/fileChange/requestApproval', { threadId: 'owned' })).rejects.toThrow('preview')
  fake.notify('item/started', { threadId: 'owned', item: { id: 'edit', type: 'fileChange', changes: [{ path: 'example.ts', diff: '+const x = 1' }] } })
  const result = fake.request('item/fileChange/requestApproval', { threadId: 'owned', itemId: 'edit' })
  await test.driver.stop()
  expect(await result).toEqual({ decision: 'decline' })
  expect(fake.calls.at(-1)).toEqual({ method: 'turn/interrupt', params: { threadId: 'owned', turnId: 'turn' } })
})

it('routes structured streaming, questions and usage without reading terminal text', async () => {
  const test = setup()
  await test.driver.start()
  fake.notify('item/agentMessage/delta', { threadId: 'owned', itemId: 'message', delta: 'Hello' })
  expect(test.updates.item).toHaveBeenCalledWith({ id: 'message', kind: 'assistant', text: 'Hello', status: 'running' }, true)
  fake.notify('thread/tokenUsage/updated', { threadId: 'owned', tokenUsage: { total: { inputTokens: 10, outputTokens: 2 } } })
  expect(test.updates.usage).toHaveBeenCalledWith({ input: 10, output: 2, cached: undefined })
  const question = fake.request('item/tool/requestUserInput', { threadId: 'owned', questions: [{ id: 'target', question: 'Which file?', options: [{ label: 'One' }] }] })
  test.gate.respond(test.approvals()[0]!.id, { decision: 'allow', answers: { target: ['Another file'] } })
  expect(await question).toEqual({ answers: { target: { answers: ['Another file'] } } })
  await test.driver.stop()
})
