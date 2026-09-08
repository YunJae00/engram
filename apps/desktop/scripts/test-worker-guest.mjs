import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { GuestWorker } from './guest-worker.mjs'
import { sampleGuestResources } from './guest-resources.mjs'

const { values } = parseArgs({ options: {
  qemu: { type: 'string' }, image: { type: 'string' }, output: { type: 'string' },
  count: { type: 'string', default: '2' }, 'boot-timeout': { type: 'string', default: '240000' },
} })
if (!values.qemu || !values.image || !values.output) throw new Error('Required: --qemu PATH --image DIRECTORY --output NEW_DIRECTORY')
const count = Number(values.count)
const bootTimeout = Number(values['boot-timeout'])
assert([1, 2].includes(count), 'Only one or two bounded guest workers are supported')
assert(bootTimeout >= 30000 && bootTimeout <= 600000, 'Invalid boot deadline')
assert(os.freemem() > (count * 1024 + 1024) * 1024 * 1024, 'Insufficient free RAM for isolated guests')
const options = { qemu: await realpath(values.qemu), image: await realpath(values.image),
  output: path.resolve(values.output), bootTimeout }
const temporaryRoot = await realpath(path.resolve('tmp'))
assert(options.output.startsWith(temporaryRoot + path.sep), 'Guest output must be in the repository tmp directory')
const sums = await readFile(path.join(options.image, 'SHA256SUMS'), 'utf8')
for (const name of ['kernel', 'initramfs.cpio.gz']) {
  const expected = sums.split(/\r?\n/).find(line => line.endsWith(`  ${name}`))?.split(' ')[0]
  const actual = createHash('sha256').update(await readFile(path.join(options.image, name))).digest('hex')
  assert.equal(actual, expected, `Image checksum mismatch: ${name}`)
}
await mkdir(options.output, { recursive: false })
const guests = []
const result = { passed: false, hostInputUsed: false, hostDisplayOpened: false,
  scope: 'Independent Linux guest input domains; not host Windows applications, enterprise SSO or browser performance',
  workerCount: count,
  startedAt: new Date().toISOString(), workers: [], cleanupCompleted: false }

async function exercise(guest, index) {
  const started = performance.now()
  const prefix = index ? 'bravo' : 'alpha'
  const text = `${prefix} 한글 ${index + 1}`
  await guest.request('/health', undefined, 'invalid-token', 401)
  await guest.click('entry')
  await guest.until(state => state.entryFocused, 'Text field did not receive virtual focus')
  await guest.typeAscii(prefix)
  await guest.until(state => state.text === prefix && state.keyEvents >= prefix.length, 'QMP keyboard input missing')
  await guest.request('/type', { text: ` 한글 ${index + 1}` })
  await guest.until(state => state.text === text, 'Guest Unicode key injection missing')
  console.log(`${guest.id}: independent keyboard input verified`)
  const clicks = index ? 5 : 3
  for (let i = 0; i < clicks; i++) await guest.click('button')
  await guest.until(state => state.clickCount === clicks, 'Virtual clicks did not reach the button')
  await guest.point('canvas')
  const wheels = index ? 7 : 4
  for (let i = 0; i < wheels; i++) await guest.button('wheel-down')
  await guest.until(state => state.wheelEvents === wheels && state.scrollY > 0, 'Virtual scroll events missing')
  await guest.click('resize')
  await guest.until(state => state.resizeCount === 1 && state.window.width <= 640, 'Guest window resize failed')
  const size = index ? { width: 800, height: 600 } : { width: 1024, height: 768 }
  await guest.request('/resize', size)
  const state = await guest.until(state => state.screen.width === size.width && state.screen.height === size.height,
    'Guest display did not resize')
  const frame = await guest.screenshot('verified')
  assert.equal(frame.width, size.width)
  assert.equal(frame.height, size.height)
  assert.equal(state.text, text)
  return { startedMs: Math.round(started), endedMs: Math.round(performance.now()), bootMs: guest.bootMs,
    startupMs: guest.startupMs, channelReadyMs: guest.channelReadyMs,
    state, frame, qmpAsciiPassed: true, unicodeInjectionPassed: true, imeCompositionTested: false }
}

async function cleanup() {
  const statuses = await Promise.allSettled(guests.map(guest => guest.stop()))
  result.cleanupCompleted = statuses.every(status => status.status === 'fulfilled')
  return statuses
}

let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true
  void cleanup().finally(() => { process.exitCode = 1 })
})
try {
  for (let index = 0; index < count; index++) {
    const guest = new GuestWorker(options, `worker-${index + 1}`)
    guests.push(guest)
    console.log(`${guest.id}: starting owned guest without a host display`)
    await guest.start()
    console.log(`${guest.id}: display ready (${guest.bootMs}ms)`)
    assert(!interrupted, 'Validation interrupted')
  }
  if (count === 2) assert.notEqual(guests[0].bootId, guests[1].bootId, 'Guests share a boot identity')
  result.workers = await Promise.all(guests.map(exercise))
  for (let index = 0; index < count; index++) {
    const final = await guests[index].state()
    const expected = result.workers[index].state
    for (const key of ['text', 'clickCount', 'wheelEvents', 'bootId']) assert.equal(final[key], expected[key])
    assert.deepEqual(final.screen, expected.screen)
    result.workers[index].finalState = final
  }
  result.idleResources = await sampleGuestResources(guests)
  if (count === 2) {
    const [a, b] = result.workers
    assert(Math.max(a.startedMs, b.startedMs) < Math.min(a.endedMs, b.endedMs), 'Input runs did not overlap')
    result.concurrentInputPassed = true
    const old = guests[0]
    await old.stop()
    await assert.rejects(old.qmp('query-status'), /closed/)
    const replacement = new GuestWorker(options, 'worker-1-restarted')
    guests.push(replacement)
    const surviving = guests[1]
    await Promise.all([replacement.start(), (async () => {
      await surviving.click('entry')
      await surviving.typeAscii(' alive')
      await surviving.until(state => state.text === 'bravo 한글 2 alive', 'Surviving worker lost input during another restart')
    })()])
    assert.notEqual(replacement.bootId, old.bootId)
    await replacement.request('/health', undefined, old.token, 401)
    const fresh = await replacement.state()
    assert.equal(fresh.text, '')
    assert.equal(fresh.clickCount, 0)
    result.restartIsolationPassed = true
    result.staleChannelRejected = true
    result.staleTokenRejected = true
    result.survivorState = await surviving.state()
    assert.equal(result.survivorState.text, 'bravo 한글 2 alive')
    result.survivorFrame = await surviving.screenshot('survived-restart')
  }
  assert(!interrupted, 'Validation interrupted')
  result.passed = true
} catch (error) {
  result.error = error.message
  if (error.inputDiagnostic) result.inputDiagnostic = error.inputDiagnostic
  console.error(error.message)
  const live = guests.filter(guest => !guest.closed)
  result.failureStates = await Promise.all(live.map(async guest => {
    try { return await guest.state() } catch { return { workerId: guest.id, stateUnavailable: true } }
  }))
  await Promise.allSettled(live.map(guest => guest.screenshot('failure')))
  if (live.length) result.failureIdleResources = await sampleGuestResources(live)
  process.exitCode = 1
} finally {
  await cleanup()
  if (!result.cleanupCompleted) { result.passed = false; process.exitCode = 1 }
  result.finishedAt = new Date().toISOString()
  await writeFile(path.join(options.output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(result, null, 2))
}
