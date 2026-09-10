import { expect, it } from 'vitest'
import { runToolSession } from '../../../packages/core/src/agent-session.js'
import { desktopTools, type DesktopAction, type DesktopGuardedAction } from '../../../packages/core/src/desktop-tools.js'
import { MockEngine } from '../../../packages/core/src/engine/mock.js'
import { engineCwd, type ToolSessionJob } from '../../../packages/core/src/engine/types.js'
import { guardedSequence } from '../src/main/desktop-guarded-sequence.js'
import type { DesktopObservationDto } from '../src/shared/desktop.js'

// A simulated provider and deterministic engine exercise the production tool
// loop together. These checks do not measure model planning or real office apps.
const draft = { name: 'Draft', controlType: 'Edit' }
const next = { name: 'Continue', controlType: 'Button' }
const summary = { name: 'Summary', controlType: 'Edit' }
const workdir = engineCwd({ workspace: '/workspace', privateDir: '/private' })
type WithoutSnapshot<T> = T extends unknown ? Omit<T, 'snapshot'> : never
type Step = WithoutSnapshot<DesktopGuardedAction>
const bounds = { x: 10, y: 10, width: 100, height: 30 }

function provider() {
  const state: DesktopObservationDto = {
    snapshot: 'initial', truncated: false, captureSafe: true,
    bounds: { x: 0, y: 0, width: 500, height: 400 }, focusedControl: 'draft', focusedEditable: true,
    nodes: [
      { id: 'e1', runtimeId: 'draft', ...draft, bounds, value: '', valueTruncated: false, actions: { type: true, replace: true } },
      { id: 'e2', runtimeId: 'continue', ...next, bounds },
      { id: 'e3', runtimeId: 'sentinel', name: 'Existing content', controlType: 'Edit', bounds, value: 'Leave unchanged' },
    ],
  }
  const observations = new Map<string, DesktopObservationDto>()
  const inputs: DesktopAction[] = []
  let reads = 0
  let readbackFails = false
  let wrongReplacement = false
  let afterInput: (() => void) | undefined
  const read = async () => {
    if (readbackFails && inputs.length) {
      readbackFails = false
      throw new Error('Simulated readback unavailable')
    }
    const view = structuredClone({ ...state, snapshot: `view-${++reads}` })
    observations.set(view.snapshot, view)
    return view
  }
  const act = async (action: DesktopAction) => {
    inputs.push(action)
    const focused = state.nodes.find((node) => node.runtimeId === state.focusedControl)!
    if (action.kind === 'type') focused.value = (focused.value ?? '') + action.text
    else if (action.kind === 'replace') {
      focused.value = wrongReplacement ? 'Unexpected partial value' : action.text
      wrongReplacement = false
    } else if (action.kind === 'click' && 'element' in action && action.element === 'e2') {
      state.nodes.push({ id: 'e4', runtimeId: 'summary', ...summary, bounds, value: '', valueTruncated: false, actions: { type: true } })
      state.focusedControl = 'summary'
    } else throw new Error('Unexpected simulated input')
    afterInput?.()
  }
  const tools = desktopTools({
    read: async () => JSON.stringify(await read()),
    sequence: async (actions, context) => {
      const original = observations.get(actions[0]!.snapshot)
      if (!original) throw new Error('Observe before input')
      if (!actions.every((action) => 'target' in action)) throw new Error('This fixture evaluates guarded steps only')
      return guardedSequence(original, actions as DesktopGuardedAction[], read, act, context.signal)
    },
  })
  return { state, inputs, tools,
    failReadback: () => { readbackFails = true },
    changeReplacement: () => { wrongReplacement = true },
    onInput: (callback: () => void) => { afterInput = callback },
  }
}

class SimulatedPlanner extends MockEngine {
  constructor(private script: (job: ToolSessionJob) => Promise<string>) { super() }
  async runTools(job: ToolSessionJob) { return { answer: await this.script(job) } }
}

function caller(job: ToolSessionJob) {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await job.tools.find((tool) => tool.name === name)!.run(args)
    return typeof result === 'string' ? result : result.text
  }
  const json = async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await call(name, args)).split('\n')[0]!)
  return { call, json,
    sequence: (view: DesktopObservationDto, actions: Step[]) => json('desktop_sequence', { snapshot: view.snapshot, actions }),
  }
}

it('replans from a wrong result, verifies two phases and never touches unrelated content', async () => {
  const ui = provider()
  ui.changeReplacement()
  const engine = new SimulatedPlanner(async (job) => {
    const { call, json, sequence } = caller(job)
    await json('task_plan', { phases: ['Draft contains the requested text', 'Summary contains the verified result'] })
    const first = await json('read_desktop')
    const failure = await sequence(first, [
      { kind: 'replace', target: draft, expected: '', text: 'Reviewed draft' },
      { kind: 'click', target: next },
    ])
    expect(failure).toMatchObject({ dispatched: 1, completed: 0, failedStep: 1, observationMayBeStale: false })
    expect(failure.error).toContain('replacement result')
    expect(await call('task_plan', { evidenceStep: 3, finding: 'Finished' })).toContain('that did not work:')
    expect(ui.state.nodes.some((node) => node.runtimeId === 'summary')).toBe(false)
    const current = await json('read_desktop')
    const revised = await json('task_plan', {
      remainingPhases: ['Correct and verify the observed draft', 'Summary contains the verified result'],
      evidenceStep: 5, finding: 'The draft contains an unexpected partial value; the summary has not been created',
    })
    expect(revised).toMatchObject({ completed: 0, current: 'Correct and verify the observed draft' })
    const corrected = await sequence(current, [
      { kind: 'replace', target: draft, expected: current.nodes[0].value, text: 'Reviewed draft' },
      { kind: 'verify', target: draft, value: 'Reviewed draft' },
    ])
    expect(corrected).toMatchObject({ completed: 2, dispatched: 1, verified: 2 })
    await json('task_plan', { evidenceStep: 7, finding: 'The complete draft reads Reviewed draft' })
    const final = await sequence(corrected.observation, [
      { kind: 'click', target: next },
      { kind: 'type', target: summary, text: 'Reviewed draft confirmed' },
      { kind: 'verify', target: summary, value: 'Reviewed draft confirmed' },
    ])
    expect(final).toMatchObject({ completed: 3, dispatched: 2, verified: 1 })
    const checkpoint = await json('task_plan', { evidenceStep: 9, finding: 'Summary reads Reviewed draft confirmed' })
    expect(checkpoint).toMatchObject({ completed: 2, current: null })
    return 'Both fields verified'
  })
  const result = await runToolSession({ engine, workdir, tools: ui.tools }, 'Update the draft and its summary; preserve existing content.')
  expect(result.incomplete).toBeUndefined()
  expect(ui.inputs.map((input) => input.kind)).toEqual(['replace', 'replace', 'click', 'type'])
  expect(ui.state.nodes.find((node) => node.runtimeId === 'draft')?.value).toBe('Reviewed draft')
  expect(ui.state.nodes.find((node) => node.runtimeId === 'summary')?.value).toBe('Reviewed draft confirmed')
  expect(ui.state.nodes.find((node) => node.runtimeId === 'sentinel')?.value).toBe('Leave unchanged')
})

it('marks uncertain readback incomplete and resumes only after observing delivered input, without replay', async () => {
  const ui = provider()
  ui.failReadback()
  const firstEngine = new SimulatedPlanner(async (job) => {
    const { json, sequence } = caller(job)
    const view = await json('read_desktop')
    const result = await sequence(view, [
      { kind: 'type', target: draft, text: 'Confirmed draft' },
      { kind: 'click', target: next },
    ])
    expect(result).toMatchObject({ dispatched: 1, completed: 0, observationMayBeStale: true, error: 'Simulated readback unavailable' })
    return 'Everything completed'
  })
  const first = await runToolSession({ engine: firstEngine, workdir, tools: ui.tools }, 'Create a draft and summary.')
  expect(first.incomplete).toBeTruthy()
  expect(first.answer).toMatch(/^Not verified as complete\./)
  expect(first.answer).toContain('Unverified response:\nEverything completed')
  expect(ui.inputs).toHaveLength(1)
  const resumedEngine = new SimulatedPlanner(async (job) => {
    const { json, sequence } = caller(job)
    const current = await json('read_desktop')
    expect(current.nodes[0].value).toBe('Confirmed draft')
    const result = await sequence(current, [
      { kind: 'verify', target: draft, value: 'Confirmed draft' },
      { kind: 'click', target: next },
      { kind: 'type', target: summary, text: 'Confirmed draft' },
      { kind: 'verify', target: summary, value: 'Confirmed draft' },
    ])
    expect(result).toMatchObject({ completed: 4, dispatched: 2, verified: 2 })
    return 'Both values now verified'
  })
  const resumed = await runToolSession({ engine: resumedEngine, workdir, tools: ui.tools }, 'Continue the unfinished summary after checking what was already entered.')
  expect(resumed.incomplete).toBeUndefined()
  expect(ui.inputs.map((input) => input.kind)).toEqual(['type', 'click', 'type'])
  expect(ui.state.nodes[0]!.value).toBe('Confirmed draft')
  expect(ui.state.nodes.find((node) => node.runtimeId === 'summary')?.value).toBe('Confirmed draft')
})

it('propagates cancellation through the session and dispatches no remaining batch input', async () => {
  const ui = provider()
  const controller = new AbortController()
  ui.onInput(() => controller.abort(new Error('Person stopped control')))
  const engine = new SimulatedPlanner(async (job) => {
    const { json, sequence } = caller(job)
    const current = await json('read_desktop')
    await sequence(current, [
      { kind: 'type', target: draft, text: 'Entered once' },
      { kind: 'click', target: next },
    ])
    throw new Error('The stopped session must not continue')
  })
  await expect(runToolSession({ engine, workdir, tools: ui.tools }, 'Prepare a draft and summary.', { signal: controller.signal })).rejects.toThrow('Person stopped control')
  expect(ui.inputs).toHaveLength(1)
  expect(ui.state.nodes[0]!.value).toBe('Entered once')
  expect(ui.state.nodes.some((node) => node.runtimeId === 'summary')).toBe(false)
})
