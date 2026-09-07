import { test, expect } from '@playwright/test'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'win32', 'Readable desktop windows use Windows UI Automation')
const run = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const desktop = fileURLToPath(new URL('../', import.meta.url))

interface State {
  window: string; pid: number; title: string; value: string; count: number; checked: boolean
  selected: number; topIndex: number; passwordUnchanged: boolean
  foreground: string; cursor: { x: number; y: number }
  token: { elevated: boolean; integrity: number; uiAccess: boolean }
}
interface Node {
  id: string; name: string; controlType: string; value: string | null; password: boolean
}
interface Observation {
  window: string; pid: number; snapshot: string; expiresInMs: number; nodes: Node[]; truncated: boolean
}

class Lines {
  readonly child: ChildProcessWithoutNullStreams
  readonly ready: Promise<Record<string, unknown>>
  private serial = 0
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()

  constructor(executable: string, args: string[] = []) {
    const name = basename(executable)
    this.child = spawn(executable, args, { windowsHide: true, stdio: 'pipe' })
    this.child.stderr.resume()
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} did not become ready`)), 20_000)
      const reader = createInterface({ input: this.child.stdout })
      reader.on('line', (line) => {
        const message = JSON.parse(line) as { type?: string; id?: number; result?: unknown; error?: string }
        if (message.type === 'ready') { clearTimeout(timer); resolve(message as Record<string, unknown>); return }
        if (message.type === 'fatal') { clearTimeout(timer); reject(new Error(`${name}: ${message.error}`)); return }
        if (typeof message.id !== 'number') return
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error))
        else pending.resolve(message.result)
      })
      this.child.on('error', (error) => { clearTimeout(timer); reject(error) })
      this.child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`${name} exited: ${code === null ? 'terminated' : `0x${(code >>> 0).toString(16)}`}`))
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Desktop process closed')) }
        this.pending.clear()
        reader.close()
      })
    })
  }

  request<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Desktop request timed out: ${method}`)) }, 15_000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, method, ...args })}\n`)
    })
  }

  async close() {
    if (this.child.exitCode !== null) return
    this.child.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.child.kill(); resolve() }, 2500)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

let helper: Lines
const fixtures: Lines[] = []
const targets: State[] = []

test.beforeAll(async () => {
  await mkdir(join(root, 'tmp'), { recursive: true })
  const work = await mkdtemp(join(root, 'tmp', 'desktop-background-'))
  const framework = join(process.env['WINDIR'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  const fixturePath = join(work, 'DesktopFixture.exe')
  await run(join(framework, 'csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', `/out:${fixturePath}`,
    ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll'].map((name) => `/reference:${name}`),
    join(desktop, 'e2e', 'fixtures', 'desktop', 'DesktopFixture.cs'),
    join(desktop, 'e2e', 'fixtures', 'desktop', 'FixturePrivilege.cs'),
    join(desktop, 'e2e', 'fixtures', 'desktop', 'FixtureTokenSecurity.cs'),
  ], { windowsHide: true })
  await run(process.execPath, [join(desktop, 'scripts', 'build-desktop.mjs')], { windowsHide: true })
  helper = new Lines(join(desktop, 'native-bin', 'desktop', 'EngramDesktop.exe'), ['--owner-pid', String(process.pid)])
  await helper.ready
  for (let lane = 0; lane < 4; lane++) {
    const fixture = new Lines(fixturePath, [String(lane + 1), '--restricted-fixture'])
    fixtures.push(fixture)
    await fixture.ready
    const state = await fixture.request<State>('state')
    expect(state.token).toEqual({ elevated: false, integrity: 8192, uiAccess: false })
    targets.push(state)
    const selected = await helper.request<{ window: string; pid: number }>('inspectWindow', { window: state.window, pid: 0 })
    expect(selected).toMatchObject({ window: state.window, pid: state.pid })
  }
})

test.afterAll(async () => { await Promise.all([...fixtures, ...(helper ? [helper] : [])].map((child) => child.close())) })

function target(lane: number) { return { window: targets[lane]!.window, pid: targets[lane]!.pid } }
function observe(lane: number) { return helper.request<Observation>('observe', target(lane)) }
function unchanged(before: State, after: State) {
  expect(after.foreground).toBe(before.foreground)
  expect(after.cursor).toEqual(before.cursor)
  expect(after).toMatchObject({ value: before.value, count: 0, checked: false, selected: 0, passwordUnchanged: true })
}

test('four background windows expose independent readable controls without taking focus or moving the pointer', async () => {
  const before = await Promise.all(fixtures.map((fixture) => fixture.request<State>('state')))
  expect(targets.map((state) => state.window)).not.toContain(before[0]!.foreground)
  for (let round = 0; round < 3; round++) {
    const observations = await Promise.all(fixtures.map((_fixture, lane) => observe(lane)))
    observations.forEach((observation, lane) => {
      expect(observation).toMatchObject(target(lane))
      expect(observation.nodes.find((node) => node.name === 'Task value')).toMatchObject({ value: `Lane ${lane + 1}` })
      expect(observation.nodes.some((node) => Object.hasOwn(node, 'actions'))).toBe(false)
    })
  }
  const after = await Promise.all(fixtures.map((fixture) => fixture.request<State>('state')))
  after.forEach((state, lane) => unchanged(before[lane]!, state))
})

test('the desktop protocol rejects every mutation method without an input fallback', async () => {
  const before = await fixtures[0]!.request<State>('state')
  for (const method of ['act', 'setValue', 'invoke', 'toggle', 'select', 'scroll', 'click', 'key']) {
    await expect(helper.request(method, { ...target(0), action: method, value: 'not allowed', element: 'e0' })).rejects.toThrow(/read-only/)
  }
  unchanged(before, await fixtures[0]!.request<State>('state'))
})

test('password controls and their contents are never exposed', async () => {
  const observation = await observe(0)
  const password = observation.nodes.find((node) => node.password)
  expect(password).toMatchObject({ name: 'Password field', value: null })
  expect(password).not.toHaveProperty('actions')
  expect(JSON.stringify(observation)).not.toContain('fixture-only-password')
  expect((await fixtures[0]!.request<State>('state')).passwordUnchanged).toBe(true)
})

test('invalid handles, wrong processes and windows without a selection are rejected', async () => {
  const before = await fixtures[0]!.request<State>('state')
  await expect(helper.request('observe', { ...target(0), pid: target(1).pid })).rejects.toThrow(/changed process/)
  await expect(helper.request('observe', { ...target(0), window: '../window' })).rejects.toThrow(/positive decimal handle/)
  await expect(helper.request('observe', { ...target(0), pid: 0 })).rejects.toThrow(/invalid pid/)
  const fresh = new Lines(join(desktop, 'native-bin', 'desktop', 'EngramDesktop.exe'), ['--owner-pid', String(process.pid)])
  try {
    await fresh.ready
    await expect(fresh.request('observe', target(0))).rejects.toThrow(/Select this window/)
  } finally { await fresh.close() }
  unchanged(before, await fixtures[0]!.request<State>('state'))
})

test('large observations remain bounded and a closed window invalidates its selection', async () => {
  await fixtures[3]!.request('largeContent')
  await expect.poll(async () => (await observe(3)).nodes.filter((node) => node.name.startsWith('Large field')).length).toBe(12)
  const observation = await observe(3)
  expect(observation.nodes.length).toBeLessThanOrEqual(160)
  expect(observation.nodes.reduce((length, node) => length + node.name.length + (node.value?.length ?? 0), 0)).toBeLessThanOrEqual(32768)
  expect(Buffer.byteLength(JSON.stringify(observation), 'utf8')).toBeLessThan(262144)
  await fixtures[3]!.request('close')
  await expect(helper.request('observe', target(3))).rejects.toThrow(/visible top-level|closed or replaced/)
})
