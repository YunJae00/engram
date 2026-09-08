import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

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
    path.join(desktop, 'e2e/fixtures/desktop/FixtureInitializationProbe.cs')], { stdio: 'inherit', windowsHide: true })
  execFileSync(launcher, [process.execPath, repository], { stdio: 'inherit', windowsHide: true, timeout: 210000 })
  process.exit(0)
}
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
  request(method, args = {}) {
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
let result = { passed: false, physicalHardwareInterruptionTested: false }
try {
  const ready = await Promise.race([fixture.ready, wait(10000).then(() => { throw new Error('Owned fixture did not start') })])
  helper = new Channel(path.join(output, 'EngramDesktop.exe'), ['--owner-pid', String(process.pid)])
  const capability = await Promise.race([helper.ready, wait(10000).then(() => { throw new Error('Desktop helper did not start') })])
  assert.equal(capability.protocol, 2)
  const target = { window: ready.window, pid: ready.pid }
  await helper.request('inspectWindow', { window: ready.window, pid: 0 })
  const readOnly = await helper.request('observe', target)
  assert.ok(readOnly.nodes.some(node => node.name === 'Worker input'))
  await fixture.request('focus')
  const active = await helper.request('bind', { ...target, grant: randomUUID() })
  const bound = { ...target, lease: active.lease }
  const observe = () => helper.request('observe', bound)
  let snapshot = await observe()
  const entry = snapshot.nodes.find(node => node.name === 'Worker input')
  assert.ok(entry)
  await helper.request('click', { ...bound, snapshot: snapshot.snapshot, element: entry.id })
  snapshot = await observe()
  assert.equal(snapshot.focusedEditable, true)
  await helper.request('type', { ...bound, snapshot: snapshot.snapshot, text: 'alpha 한글 🚀' })
  await until(() => fixture.request('state'), state => state.text === 'alpha 한글 🚀', 'Native Unicode entry did not reach the fixture')
  snapshot = await observe()
  const button = snapshot.nodes.find(node => node.name === 'Count click')
  assert.ok(button)
  await helper.request('click', { ...bound, snapshot: snapshot.snapshot, element: button.id })
  await until(() => fixture.request('state'), state => state.clicks === 1, 'Native click did not reach the fixture')
  snapshot = await observe()
  await helper.request('scroll', { ...bound, snapshot: snapshot.snapshot, delta: -3 })
  await until(() => fixture.request('state'), state => state.wheelEvents >= 3 && state.scrollY > 0, 'Native scrolling did not move the fixture content')
  snapshot = await observe()
  await helper.request('key', { ...bound, snapshot: snapshot.snapshot, key: 'Tab' })
  snapshot = await observe()
  await helper.request('stop')
  await assert.rejects(helper.request('key', { ...bound, snapshot: snapshot.snapshot, key: 'Enter' }))
  await fixture.request('focus')
  const second = await helper.request('bind', { ...target, grant: randomUUID() })
  await helper.request('observe', { ...target, lease: second.lease })
  await fixture.request('foreignInput')
  await until(async () => helper.events, events => events.some(event => event.type === 'revoked' && event.lease === second.lease), 'Independent input did not revoke desktop control')
  await assert.rejects(helper.request('observe', { ...target, lease: second.lease }))
  await fixture.request('password')
  const protectedView = await helper.request('observe', target)
  assert.ok(protectedView.protectedBounds.length > 0)
  assert.equal(protectedView.focusedEditable, false)
  await assert.rejects(helper.request('bind', { ...target, grant: randomUUID() }))
  result = { ...result, passed: true, unicodePassed: true, clickPassed: true, scrollPassed: true, keyPassed: true,
    stopRevocationPassed: true, foreignInjectedRevocationPassed: true, passwordRejectionPassed: true, readOnlyPassed: true }
  console.log('Native desktop CI fixture integration passed')
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  if (helper) await helper.close()
  await fixture.close()
  writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(`Native desktop CI evidence: ${output}`)
}
