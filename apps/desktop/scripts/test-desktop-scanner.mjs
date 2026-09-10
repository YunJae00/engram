import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function bounded(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
function channel(executable, args) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let pending
  let failure
  let stderr = ''
  const queue = []
  const lines = readline.createInterface({ input: child.stdout })
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2000) })
  const fail = error => { failure = error; pending?.reject(error); pending = undefined }
  child.once('error', fail)
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    fail(new Error(`Scanner fixture exited (${code ?? signal}): ${stderr}`))
    resolve()
  }))
  lines.on('line', line => {
    try {
      assert.ok(line.length <= 4096, 'Scanner fixture response exceeded its bound')
      const value = JSON.parse(line)
      if (pending) { pending.resolve(value); pending = undefined } else queue.push(value)
    } catch (error) { fail(error) }
  })
  return {
    child, exited,
    next() {
      if (queue.length) return Promise.resolve(queue.shift())
      if (failure) return Promise.reject(failure)
      assert.equal(pending, undefined)
      return bounded(new Promise((resolve, reject) => { pending = { resolve, reject } }), 5000, 'Scanner fixture response timed out')
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.stdin.end()
      await Promise.race([exited, wait(1000)])
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await bounded(exited, 3000, 'Scanner fixture did not exit')
    },
  }
}
async function gone(pid) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) }
    catch (error) { if (error.code === 'ESRCH') return; throw error }
    await wait(25)
  }
  assert.fail('The owned scanner remained alive after its owner stopped')
}
export function testDesktopScannerProtocol(desktop, output) {
  assert.equal(process.platform, 'win32')
  const framework = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319')
  const executable = path.join(output, 'ScannerProtocolCheck.exe')
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/reference:System.dll',
    '/reference:System.Web.Extensions.dll', `/out:${executable}`,
    path.join(desktop, 'e2e/fixtures/desktop/ScannerProtocolCheck.cs')], { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  const result = JSON.parse(execFileSync(executable, [path.join(output, 'EngramDesktop.exe')],
    { windowsHide: true, encoding: 'utf8', timeout: 10000 }))
  assert.ok(Number.isInteger(result.protocolChecks) && result.protocolChecks >= 30)
  return result
}
export async function testDesktopScanner(desktop, output, target) {
  if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Scanner lifecycle checks require an isolated Windows CI runner')
  }
  assert.match(String(target.window), /^[1-9][0-9]*$/)
  assert.ok(Number.isInteger(target.pid) && target.pid > 0)
  const framework = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319')
  const lifecycle = path.join(output, 'ScannerLifecycleProbe.exe')
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/reference:System.dll',
    `/out:${lifecycle}`, path.join(desktop, 'e2e/fixtures/desktop/ScannerLifecycleProbe.cs'),
    path.join(desktop, 'native/desktop/ScannerJob.cs')], { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  const result = testDesktopScannerProtocol(desktop, output)
  let targetStarted
  for (const mode of ['dispose', 'eof', 'parentDeath']) {
    const coldStart = performance.now()
    const owner = channel(lifecycle, [path.join(output, 'EngramDesktop.exe'), String(target.window), String(target.pid)])
    try {
      const ready = await owner.next()
      assert.equal(ready.type, 'ready')
      assert.ok(Number.isInteger(ready.pid) && ready.pid > 0 && ready.pid !== process.pid)
      assert.match(ready.started, /^[1-9][0-9]*$/)
      targetStarted = ready.started
      const samples = []
      for (let id = 1; id <= (mode === 'dispose' ? 3 : 1); id++) {
        const request = { id, window: String(target.window), pid: target.pid, started: ready.started }
        const start = performance.now()
        owner.child.stdin.write(`${JSON.stringify(request)}\n`)
        const reply = await owner.next()
        for (const key of ['id', 'window', 'pid', 'started']) assert.equal(reply[key], request[key], `Scanner returned another ${key}`)
        assert.equal(reply.complete, true, 'The actual isolated scanner did not complete its fresh scan')
        assert.equal(reply.password, false, 'The owned normal fixture was incorrectly marked as protected')
        assert.ok(Number.isFinite(reply.elapsedMs) && reply.elapsedMs >= 0)
        assert.ok(Number.isInteger(reply.workingSetBytes) && reply.workingSetBytes > 0)
        samples.push({ elapsedMs: reply.elapsedMs, roundTripMs: performance.now() - start })
        if (id === 1 && mode === 'dispose') result.coldMs = performance.now() - coldStart
      }
      if (mode === 'dispose') {
        owner.child.stdin.write('memory\n')
        const memory = await owner.next()
        assert.ok(Number.isInteger(memory.workingSetBytes) && memory.workingSetBytes > 0)
        assert.ok(Number.isInteger(memory.privateBytes) && memory.privateBytes > 0)
        result.samples = samples
        result.memory = memory
      }
      if (mode === 'dispose') {
        owner.child.stdin.write('dispose\n')
        assert.equal((await owner.next()).exited, true)
      } else if (mode === 'eof') {
        owner.child.stdin.write('eof\n')
        assert.equal((await owner.next()).exited, true)
      }
      else owner.child.kill()
      await bounded(owner.exited, 3000, 'Scanner owner did not exit')
      await gone(ready.pid)
      result[mode] = true
    } finally { await owner.close() }
  }
  const timeoutProbe = path.join(output, 'ScannerTimeoutProbe.exe')
  execFileSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/reference:System.dll',
    '/reference:System.Core.dll', '/reference:System.Web.Extensions.dll', `/out:${timeoutProbe}`,
    path.join(desktop, 'e2e/fixtures/desktop/ScannerTimeoutProbe.cs'), path.join(desktop, 'native/desktop/PasswordScanBroker.cs'),
    path.join(desktop, 'native/desktop/ScannerJob.cs')], { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  result.timeout = JSON.parse(execFileSync(timeoutProbe, [path.join(output, 'scanner-timeout-pid.txt'), String(target.window), String(target.pid), targetStarted],
    { windowsHide: true, encoding: 'utf8', timeout: 10000 }))
  assert.equal(result.timeout.unavailable, true)
  assert.equal(result.timeout.exited, true)
  assert.equal(result.timeout.sticky, true)
  return result
}
