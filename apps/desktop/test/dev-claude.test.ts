import { expect, it, vi } from 'vitest'
import type { DevApproval, DevSession } from '../src/shared/developers.js'

const fake = vi.hoisted(() => ({ options: {} as Record<string, unknown>, messages: [] as Record<string, unknown>[], end: () => {}, interrupt: vi.fn() }))
vi.mock('../src/main/process-client.js', () => ({ spawnRuntime: vi.fn() }))
vi.mock('../src/main/claude-runtime.js', () => ({ installedClaudeBinary: () => 'runtime', loadClaudeSdk: async () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    fake.options = options
    const ended = new Promise<void>(resolve => { fake.end = resolve })
    return { async *[Symbol.asyncIterator]() { for (const message of fake.messages) yield message; await ended; yield { type: 'system', subtype: 'closed' } }, interrupt: async () => { fake.interrupt(); fake.end() } }
  },
}) }))
import { DevClaude } from '../src/main/dev-claude.js'
import { DevApprovals } from '../src/main/dev-approvals.js'

function setup(mode: DevSession['mode'] = 'review') {
  fake.messages = []
  let shown: DevApproval[] = []
  const gate = new DevApprovals(value => { shown = value })
  const session: DevSession = { id: 'local', repoId: 'repo', provider: 'claude', model: '', mode, cwd: '.', title: 'Task', createdAt: 0, updatedAt: 0, state: 'idle', items: [], pending: [], usage: {} }
  const updates = { item: vi.fn(), usage: vi.fn(), finished: vi.fn() }
  const driver = new DevClaude(session, gate, updates)
  const hook = (name: string, input: Record<string, unknown> = {}) => {
    const hooks = fake.options['hooks'] as { PreToolUse: { hooks: ((input: unknown, id: string, options: { signal: AbortSignal }) => Promise<{ hookSpecificOutput: { permissionDecision: string; updatedInput?: unknown } }>)[] }[] }
    return hooks.PreToolUse[0]!.hooks[0]!({ tool_name: name, tool_input: input }, 'tool', { signal: new AbortController().signal })
  }
  return { driver, gate, shown: () => shown, hook, updates }
}

it('gates shell actions before native auto-approval and rejects them in plan mode', async () => {
  const test = setup('auto-edit')
  await test.driver.start()
  expect(fake.options).toMatchObject({ settingSources: [], strictMcpConfig: true, permissionMode: 'default' })
  const action = test.hook('Bash', { command: 'delete files' })
  await vi.waitFor(() => expect(test.shown()).toHaveLength(1))
  test.gate.respond(test.shown()[0]!.id, { decision: 'deny' })
  expect((await action).hookSpecificOutput.permissionDecision).toBe('deny')
  await test.driver.stop()
  const plan = setup('plan')
  await plan.driver.start()
  expect((await plan.hook('Write', { file_path: 'file', content: 'no' })).hookSpecificOutput.permissionDecision).toBe('deny')
  await plan.driver.stop()
})

it('keeps agent cards and plan content when their tool results arrive', async () => {
  const test = setup()
  fake.messages = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'agent', name: 'Agent', input: { description: 'Inspect fixture' } }, { type: 'tool_use', id: 'plan', name: 'TodoWrite', input: { todos: [{ content: 'Inspect fixture', status: 'completed' }] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent', content: 'Complete' }, { type: 'tool_result', tool_use_id: 'plan', content: 'Updated' }] } },
  ]
  await test.driver.start()
  await vi.waitFor(() => expect(test.updates.item).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent', kind: 'agent', status: 'done' })))
  expect(test.updates.item).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan', kind: 'plan', text: expect.stringContaining('Inspect fixture'), status: 'done' }))
  await test.driver.stop()
})

it('returns structured answers and denies pending actions when stopped', async () => {
  const test = setup()
  await test.driver.start()
  const ask = fake.options['canUseTool'] as (name: string, input: unknown, options: { signal: AbortSignal }) => Promise<{ updatedInput: unknown }>
  const question = ask('AskUserQuestion', { questions: [{ question: 'Which?', options: [{ label: 'One' }] }] }, { signal: new AbortController().signal })
  test.gate.respond(test.shown()[0]!.id, { decision: 'allow', answers: { '0': ['Two'] } })
  expect((await question).updatedInput).toMatchObject({ answers: { 'Which?': 'Two' } })
  const action = test.hook('Bash', { command: 'command' })
  await vi.waitFor(() => expect(test.shown()).toHaveLength(1))
  await test.driver.stop()
  expect((await action).hookSpecificOutput.permissionDecision).toBe('deny')
})
