import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { testDesktopBrowser } from './test-desktop-browser.mjs'
import { testDesktopInterruption } from './test-desktop-interruption.mjs'
import { testDesktopPartial } from './test-desktop-partial.mjs'
import { testDesktopReplace } from './test-desktop-replace.mjs'
import { testDesktopRemoteBytecode } from './test-desktop-remote-bytecode.mjs'
import { testDesktopScanner } from './test-desktop-scanner.mjs'
import { guardedSequence } from '../src/main/desktop-guarded-sequence.ts'

if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Native desktop integration requires an isolated Windows CI runner')
}
const desktop = fileURLToPath(new URL('..', import.meta.url))
const repository = path.resolve(desktop, '../..')
const output = path.join(repository, 'tmp', `desktop-native-ci-${randomUUID()}`)
mkdirSync(output, { recursive: true })
const framework = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319')
if (process.env.ENGRAM_DESKTOP_MEDIUM_CHILD !== 'true') {
  const launcher = path.join(output, 'MediumHarness.exe')
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Xml.dll',
    `/out:${launcher}`, path.join(desktop, 'e2e/fixtures/desktop/MediumHarness.cs'),
    path.join(desktop, 'e2e/fixtures/desktop/RestrictedFixtureToken.cs'),
    path.join(desktop, 'e2e/fixtures/desktop/FixtureAccessProbe.cs'),
    path.join(desktop, 'e2e/fixtures/desktop/FixtureProcessSecurity.cs'),
    path.join(desktop, 'e2e/fixtures/desktop/FixtureDefaultDacl.cs'),
    path.join(desktop, 'e2e/fixtures/desktop/FixtureInitializationProbe.cs')], { stdio: 'inherit', windowsHide: true })
  execFileSync(launcher, [process.execPath, repository], { stdio: 'inherit', windowsHide: true, timeout: 330000 })
  process.exit(0)
}
console.log(JSON.stringify({ remoteBytecode: testDesktopRemoteBytecode(desktop, output) }))
execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(desktop, 'scripts/build-desktop.ps1'), '-OutputPath', output], { stdio: 'inherit', windowsHide: true })
execFileSync(path.join(output, 'EngramDesktop.exe'), ['--self-test'], { stdio: 'inherit', windowsHide: true })
execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/reference:System.dll',
  '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
  `/out:${path.join(output, 'ControlFixture.exe')}`, path.join(desktop, 'e2e/fixtures/desktop/ControlFixture.cs')], { stdio: 'inherit', windowsHide: true })

class Channel {
  constructor(executable, args) {
    this.child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.waiting = new Map()
    this.events = []
    this.sequence = 0
    this.stderr = ''
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    const lines = readline.createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      try {
        const message = JSON.parse(line)
        if (message.type === 'ready') this.resolveReady(message)
        else if (message.type === 'fatal') this.rejectReady(new Error(message.error))
        else if (message.type) this.events.push(message)
        else {
          const pending = this.waiting.get(message.id)
          if (!pending) return
          this.waiting.delete(message.id)
          clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(message.error))
          else pending.resolve(message.result)
        }
      } catch (error) { this.rejectReady(error) }
    })
    this.child.stderr.on('data', chunk => { this.stderr = `${this.stderr}${chunk}`.slice(-16000) })
    this.child.on('error', error => this.rejectReady(error))
    this.child.on('exit', code => {
      const error = new Error(`Desktop fixture process exited (${code}): ${this.stderr}`)
      this.rejectReady(error)
      for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(error) }
      this.waiting.clear()
    })
  }
  async request(method, args = {}, prepared = false) {
    if (method === 'bind' && !prepared) await this.request('prepare', args)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`${method} timed out`)) }, 20000)
      this.waiting.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, method, ...args })}\n`)
    })
  }
  async close() {
    if (this.child.exitCode !== null) return
    const exit = new Promise(resolve => this.child.once('exit', resolve))
    this.child.stdin.end()
    await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 2500))])
    if (this.child.exitCode === null) this.child.kill()
    await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 2500))])
    assert.notEqual(this.child.exitCode, null, 'Owned test process did not exit')
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, predicate, label) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const state = await read()
    if (predicate(state)) return state
    await wait(80)
  }
  throw new Error(label)
}
const fixture = new Channel(path.join(output, 'ControlFixture.exe'), ['--ci-fixture'])
let helper
let overlayOwner
let result = { passed: false, physicalHardwareInterruptionTested: false }
try {
  result.stage = 'fixture-ready'
  const ready = await Promise.race([fixture.ready, wait(10000).then(() => { throw new Error('Owned fixture did not start') })])
  assert.equal(ready.visible, true)
  result.stage = 'helper-ready'
  helper = new Channel(path.join(output, 'EngramDesktop.exe'), ['--owner-pid', String(process.pid)])
  const capability = await Promise.race([helper.ready, wait(10000).then(() => { throw new Error('Desktop helper did not start') })])
  assert.equal(capability.protocol, 2)
  result.stage = 'app-launch'
  const launchers = await helper.request('listApps')
  const notepadApp = launchers.find(app => /notepad/i.test(app.name))
  assert.ok(notepadApp, 'Registered Notepad app was not discovered')
  await assert.rejects(helper.request('openApp', { app: 'cmd.exe' }), /Paths and commands/)
  assert.equal((await helper.request('openApp', { app: notepadApp.id })).requested, true)
  const launched = await until(() => helper.request('listWindows'), value => value.windows.some(window => /notepad/i.test(window.title)), 'Notepad did not expose a window after launch')
  const notepad = launched.windows.find(window => /notepad/i.test(window.title))
  const launchedView = await helper.request('observe', { window: notepad.window, pid: notepad.pid })
  assert.ok(launchedView.snapshot)
  result.appLaunchPassed = true
  const target = { window: ready.window, pid: ready.pid }
  result.stage = 'scanner-lifecycle'
  result.scanner = await testDesktopScanner(desktop, output, target)
  result.stage = 'inspect-window'
  await helper.request('inspectWindow', { window: ready.window, pid: 0 })
  const readOnly = await helper.request('observe', target)
  assert.ok(readOnly.nodes.some(node => node.name === 'Worker input'))
  result.readOnlyPassed = true
  result.stage = 'client-capture'
  const capture = await helper.request('capture', { ...target, snapshot: readOnly.snapshot })
  assert.equal(capture.basis, 'client-physical')
  assert.deepEqual(capture.bounds, readOnly.captureBounds)
  assert.equal((await fixture.request('verifyCapture', { capture })).aligned, true)
  result.captureAlignmentPassed = true
  for (const layout of ['resize', 'maximize', 'restore']) {
    result.stage = `capture-${layout}`
    await fixture.request(layout)
    const view = await helper.request('observe', target)
    const frame = await helper.request('capture', { ...target, snapshot: view.snapshot })
    assert.deepEqual(frame.bounds, view.captureBounds)
    assert.equal((await fixture.request('verifyCapture', { capture: frame })).aligned, true)
  }
  result.captureResizePassed = true
  result.stage = 'bind'
  await fixture.request('focus')
  await fixture.request('foreignInput')
  await until(() => helper.request('inputState'), state => state.idleMs >= 150, 'Fixture input did not settle')
  assert.equal((await fixture.request('away')).foreground, false)
  const activationInput = await helper.request('inputState')
  const cancelledGrant = { ...target, grant: randomUUID(), intervention: activationInput.intervention }
  await helper.request('prepare', cancelledGrant)
  await helper.request('stop')
  await assert.rejects(helper.request('bind', cancelledGrant, true))
  assert.equal((await fixture.request('state')).foreground, false)
  result.preparationStopPassed = true
  const activationGrant = { ...target, grant: randomUUID(), intervention: activationInput.intervention }
  await helper.request('prepare', activationGrant)
  await fixture.request('grantForeground', { pid: helper.child.pid })
  const active = await helper.request('bind', activationGrant, true)
  assert.equal((await fixture.request('state')).foreground, true)
  result.foregroundHandoffPassed = true
  result.foregroundRelayPassed = true
  const bound = { ...target, lease: active.lease }
  const observe = () => helper.request('observe', bound)
  let snapshot = await observe()
  const entry = snapshot.nodes.find(node => node.name === 'Worker input')
  assert.ok(entry)
  result.stage = 'idle-and-work'
  await helper.request('idle', bound)
  assert.equal((await helper.request('inputState')).working, false)
  await wait(200)
  assert.equal((await helper.request('inputState')).working, false)
  await helper.request('work', bound)
  assert.equal((await helper.request('inputState')).working, true)
  result.idleReleasePassed = true
  result.stage = 'click-entry'
  await helper.request('click', { ...bound, snapshot: snapshot.snapshot, element: entry.id })
  snapshot = await observe()
  assert.equal(snapshot.focusedEditable, true)
  result.stage = 'unicode-entry'
  await helper.request('type', { ...bound, snapshot: snapshot.snapshot, text: 'alpha 한글 🚀' })
  await until(() => fixture.request('state'), state => state.text === 'alpha 한글 🚀', 'Native Unicode entry did not reach the fixture')
  result.unicodePassed = true
  result.stage = 'editing-chord'
  snapshot = await observe()
  await helper.request('key', { ...bound, snapshot: snapshot.snapshot, key: 'Control+A' })
  snapshot = await observe()
  await helper.request('type', { ...bound, snapshot: snapshot.snapshot, text: 'Edited sample' })
  await until(() => fixture.request('state'), state => state.text === 'Edited sample', 'Selection and replacement did not reach the fixture')
  result.editingChordPassed = true
  result.stage = 'click-button'
  snapshot = await observe()
  const button = snapshot.nodes.find(node => node.name === 'Count click')
  assert.ok(button)
  const x = (button.bounds.x + button.bounds.width / 2 - snapshot.captureBounds.x) / (snapshot.captureBounds.width - 1)
  const y = (button.bounds.y + button.bounds.height / 2 - snapshot.captureBounds.y) / (snapshot.captureBounds.height - 1)
  await helper.request('click', { ...bound, snapshot: snapshot.snapshot,
    x: Math.round(snapshot.captureBounds.x + x * (snapshot.captureBounds.width - 1)),
    y: Math.round(snapshot.captureBounds.y + y * (snapshot.captureBounds.height - 1)) })
  await until(() => fixture.request('state'), state => state.clicks === 1, 'Native click did not reach the fixture')
  result.clickPassed = true
  result.stage = 'observed-input-sequence'
  const sequenceStart = performance.now()
  for (let index = 0; index < 7; index++) {
    const next = await helper.request('observe', bound)
    const targetButton = next.nodes.filter(node => node.name === 'Count click')
    assert.equal(targetButton.length, 1)
    await helper.request('click', { ...bound, snapshot: next.snapshot, element: targetButton[0].id })
    await until(() => fixture.request('state'), state => state.clicks === index + 2, 'Observed sequence input was not applied')
  }
  result.observedSequenceMs = Math.round(performance.now() - sequenceStart)
  result.stage = 'scroll'
  snapshot = await observe()
  await helper.request('scroll', { ...bound, snapshot: snapshot.snapshot, delta: -3 })
  await until(() => fixture.request('state'), state => state.wheelEvents >= 3 && state.scrollY > 0, 'Native scrolling did not move the fixture content')
  result.scrollPassed = true
  result.stage = 'key-and-stop'
  snapshot = await observe()
  await helper.request('key', { ...bound, snapshot: snapshot.snapshot, key: 'Tab' })
  snapshot = await observe()
  await helper.request('stop')
  await assert.rejects(helper.request('key', { ...bound, snapshot: snapshot.snapshot, key: 'Enter' }))
  result.stopRevocationPassed = true
  result.stage = 'foreground-input-interruption'
  await fixture.request('focus')
  const oldInput = await helper.request('inputState')
  await fixture.request('foreignInput')
  await until(() => helper.request('inputState'), state => state.intervention !== oldInput.intervention, 'Input epoch did not change')
  await assert.rejects(helper.request('bind', { ...target, grant: randomUUID(), intervention: oldInput.intervention }), /User input changed/)
  result.foregroundInterruptionPassed = true
  result.stage = 'foreign-input'
  await fixture.request('focus')
  const second = await helper.request('bind', { ...target, grant: randomUUID() })
  await helper.request('observe', { ...target, lease: second.lease })
  await fixture.request('foreignInput')
  await until(async () => helper.events, events => events.some(event => event.type === 'revoked' && event.lease === second.lease), 'Independent input did not revoke desktop control')
  await assert.rejects(helper.request('observe', { ...target, lease: second.lease }))
  result.foreignInjectedRevocationPassed = true
  const input = await helper.request('inputState')
  assert.ok(Number.isFinite(input.idleMs) && input.idleMs >= 0)
  await fixture.request('foreignEscape')
  await until(() => helper.request('inputState'), state => state.escaped === true, 'Escape during pause was not recorded')
  result.pausedEscapePassed = true
  result.stage = 'escape-while-idle'
  await fixture.request('focus')
  const resting = await helper.request('bind', { ...target, grant: randomUUID() })
  const restingBound = { ...target, lease: resting.lease }
  await helper.request('idle', restingBound)
  await fixture.request('foreignEscape')
  await until(() => helper.request('inputState'), state => state.escaped && !state.working, 'Escape while idle did not stop control')
  await assert.rejects(helper.request('work', restingBound))
  result.idleEscapePassed = true
  result.stage = 'password-during-typing'
  result.passwordDuringTyping = await testDesktopInterruption(helper, fixture, target)
  await testDesktopReplace(helper, fixture, target, result, until)
  await testDesktopPartial(helper, fixture, target, result, until, desktop, output)
  result.stage = 'guarded-workflow'
  await fixture.request('hidePassword')
  const beforeWorkflow = await fixture.request('workflow')
  const workflowLease = await helper.request('bind', { ...target, grant: randomUUID() })
  const workflowBound = { ...target, lease: workflowLease.lease }
  const workflowRead = () => helper.request('observe', workflowBound)
  const workflowAct = ({ kind, snapshot, ...args }) => helper.request(kind, { ...workflowBound, snapshot, ...args })
  const workflowView = await workflowRead()
  const draftTarget = { name: 'Draft value', controlType: 'Edit' }
  const workflowSteps = [
    { kind: 'click', target: { name: 'Open draft', controlType: 'Button' } },
    { kind: 'click', target: draftTarget },
    { kind: 'type', target: draftTarget, text: '검증된 초안 42' },
    { kind: 'verify', target: draftTarget, value: '검증된 초안 42' },
    { kind: 'click', target: { name: 'Review draft', controlType: 'Button' } },
    { kind: 'verify', target: { name: 'Reviewed value', controlType: 'Edit' }, value: '검증된 초안 42' },
  ].map(step => ({ ...step, snapshot: workflowView.snapshot }))
  const workflowResult = JSON.parse(await guardedSequence(workflowView, workflowSteps, workflowRead, workflowAct))
  assert.equal(workflowResult.error, undefined, workflowResult.error)
  assert.equal(workflowResult.completed, 6)
  assert.equal(workflowResult.dispatched, 4)
  assert.equal(workflowResult.verified, 2)
  const workflowState = await fixture.request('state')
  assert.equal(workflowState.reviewed, '검증된 초안 42')
  assert.equal(workflowState.text, beforeWorkflow.text, 'The existing unrelated field changed')
  result.guardedWorkflowMs = workflowResult.elapsedMs
  const mismatch = JSON.parse(await guardedSequence(await workflowRead(), [
    { kind: 'verify', target: draftTarget, value: 'not the result' },
    { kind: 'click', target: { name: 'Count click', controlType: 'Button' } },
  ], workflowRead, workflowAct))
  assert.match(mismatch.error, /not observed/)
  assert.equal(mismatch.dispatched, 0)
  assert.equal((await fixture.request('state')).clicks, workflowState.clicks)
  result.guardedWorkflowPassed = true
  result.guardedMismatchStopPassed = true
  await helper.request('stop')
  await fixture.request('endWorkflow')
  result.stage = 'password'
  await fixture.request('password')
  const protectedView = await helper.request('observe', target)
  assert.ok(protectedView.protectedBounds.length > 0)
  assert.equal(protectedView.focusedEditable, false)
  await assert.rejects(helper.request('bind', { ...target, grant: randomUUID() }))
  result.stage = 'browser-input'
  // The foreground consent owner may grant activation to its owned helper.
  await fixture.request('grantForeground', { pid: helper.child.pid })
  result.browserInputPassed = await testDesktopBrowser(helper, desktop, output, until)
  result.stage = 'external-stop-overlay'
  await helper.close()
  await fixture.request('hidePassword')
  const ownerPath = path.join(output, 'StopOverlayFixture.exe')
  copyFileSync(path.join(output, 'ControlFixture.exe'), ownerPath)
  overlayOwner = new Channel(ownerPath, ['--ci-fixture'])
  const owner = await overlayOwner.ready
  helper = new Channel(path.join(output, 'EngramDesktop.exe'), ['--owner-pid', String(owner.pid)])
  await helper.ready
  await helper.request('inspectWindow', { window: target.window, pid: 0 })
  await fixture.request('focus')
  await assert.rejects(helper.request('bind', { ...target, grant: randomUUID(), overlay: target.window }), /stop control could not be displayed/)
  const external = await helper.request('bind', { ...target, grant: randomUUID(), overlay: owner.window })
  const externalBound = { ...target, lease: external.lease, overlay: owner.window }
  const externalView = await helper.request('observe', externalBound)
  await helper.request('idle', externalBound)
  assert.equal((await helper.request('inputState')).working, false)
  await helper.request('work', externalBound)
  assert.equal((await helper.request('inputState')).working, true)
  await helper.request('type', { ...externalBound, snapshot: externalView.snapshot, text: 'Single overlay input' })
  await until(() => fixture.request('state'), state => state.text.includes('Single overlay input'), 'External-overlay input did not reach the fixture')
  await overlayOwner.request('hide')
  await until(() => helper.request('inputState'), state => !state.working, 'Hidden stop overlay did not release input')
  await assert.rejects(helper.request('work', externalBound))
  result.externalOverlayPassed = true
  result = { ...result, stage: 'complete', passed: true, unicodePassed: true, clickPassed: true, scrollPassed: true, keyPassed: true,
    stopRevocationPassed: true, foreignInjectedRevocationPassed: true, passwordRejectionPassed: true, readOnlyPassed: true }
  console.log('Native desktop CI fixture integration passed')
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  result.helperDiagnostics = helper?.stderr
  result.events = helper?.events.slice(-20)
  try { result.fixtureState = await fixture.request('state') } catch { result.fixtureUnavailable = true }
  throw error
} finally {
  if (helper) await helper.close()
  if (overlayOwner) await overlayOwner.close()
  await fixture.close()
  writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(`Native desktop CI evidence: ${output}`)
}
