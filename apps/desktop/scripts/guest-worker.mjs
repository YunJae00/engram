import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

export class GuestWorker {
  constructor(options, id) {
    this.options = options
    this.id = id
    this.token = randomBytes(32).toString('hex')
    this.pending = new Map()
    this.sequence = 0
    this.closed = false
    this.closing = false
    this.directory = path.join(options.output, id)
  }

  async start() {
    if (this.closing) throw new Error('Guest channel closed')
    const launched = performance.now()
    await mkdir(this.directory, { recursive: false })
    this.port = await reservePort()
    if (this.closing) throw new Error('Guest channel closed')
    const args = [
      '-name', this.id, '-machine', 'q35', '-accel', 'tcg', '-smp', '1', '-m', '1024',
      '-display', 'none', '-monitor', 'none', '-qmp', 'stdio', '-no-reboot',
      ...(process.platform === 'win32' ? ['-L', path.join(path.dirname(this.options.qemu), 'share')] : []),
      '-kernel', path.join(this.options.image, 'kernel'),
      '-initrd', path.join(this.options.image, 'initramfs.cpio.gz'),
      // Single-vCPU software guests use legacy interrupt routing.
      '-append', 'console=ttyS0,115200 rdinit=/init rootfstype=ramfs noapic panic=1',
      '-chardev', `file,id=serial0,path=${path.join(this.directory, 'serial.log')}`,
      '-serial', 'chardev:serial0',
      '-device', 'virtio-vga,id=display0', '-device', 'qemu-xhci',
      '-device', 'usb-tablet,id=pointer0,display=display0',
      '-netdev', `user,id=net0,restrict=on,ipv6=off,hostfwd=tcp:127.0.0.1:${this.port}-:8080`,
      '-device', 'virtio-net-pci,netdev=net0',
      '-fw_cfg', `name=opt/engram/worker-id,string=${this.id}`,
      '-fw_cfg', `name=opt/engram/token,string=${this.token}`,
    ]
    const log = createWriteStream(path.join(this.directory, 'qemu.log'), { flags: 'wx' })
    await new Promise((resolve, reject) => { log.once('open', resolve); log.once('error', reject) })
    if (this.closing) { log.end(); throw new Error('Guest channel closed') }
    log.on('error', error => {
      this.rejectPending(error)
      if (this.child && !this.closed) this.child.kill()
    })
    this.child = spawn(this.options.qemu, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.pipe(log)
    this.exited = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.closed = true
      this.exit = { code, signal }
      this.rejectPending(new Error(`${this.id}: guest exited (${code ?? signal})`))
      log.end()
      resolve(this.exit)
    }))
    let greet
    let failGreeting
    const greeting = new Promise((resolve, reject) => { greet = resolve; failGreeting = reject })
    const timer = setTimeout(() => failGreeting(new Error('QMP greeting timed out')), 90000)
    this.child.once('error', error => { failGreeting(error); this.rejectPending(error) })
    this.child.stdin.on('error', error => this.rejectPending(error))
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.QMP) greet(message.QMP)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(`${this.id}: ${message.error.desc}`))
      else pending.resolve(message.return)
    })
    try { this.version = await greeting } finally { clearTimeout(timer) }
    await this.qmp('qmp_capabilities')
    this.channelReadyMs = Math.round(performance.now() - launched)
    const started = performance.now()
    const deadline = started + this.options.bootTimeout
    let lastProgress = started
    while (performance.now() < deadline) {
      if (this.closed) throw new Error(`${this.id}: exited during boot; inspect serial.log and qemu.log`)
      try {
        const health = await this.request('/health')
        if (health.workerId !== this.id || !health.bootId) throw new Error('Guest identity mismatch')
        const state = await this.state()
        if (state.bootId !== health.bootId) throw new Error('Guest identity mismatch')
        if (state.bounds.entry.width > 100 && state.screen.width >= 800) {
          this.bootId = health.bootId
          this.bootMs = Math.round(performance.now() - started)
          this.startupMs = Math.round(performance.now() - launched)
          return state
        }
      } catch (error) {
        if (error.message === 'Guest identity mismatch') throw error
      }
      if (performance.now() - lastProgress > 20000) {
        console.log(`${this.id}: waiting for guest display (${Math.round((performance.now() - started) / 1000)}s)`)
        lastProgress = performance.now()
      }
      await delay(750)
    }
    throw new Error(`${this.id}: guest boot deadline exceeded; inspect serial.log`)
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  qmp(execute, args = {}) {
    if (this.closed || !this.child?.stdin.writable) return Promise.reject(new Error('Guest channel closed'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${execute}: QMP deadline exceeded`))
      }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      const parameters = execute === 'input-send-event' ? { device: 'display0', ...args } : args
      this.child.stdin.write(JSON.stringify({ execute, arguments: parameters, id }) + '\n')
    })
  }

  async request(endpoint, data, token = this.token, expectedStatus = 200) {
    if (this.closed) throw new Error('Guest channel closed')
    const response = await fetch(`http://127.0.0.1:${this.port}${endpoint}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(data === undefined ? 3000 : 15000),
    })
    if (response.status !== expectedStatus) throw new Error(`${this.id}: ${endpoint} returned ${response.status}`)
    return response.json()
  }

  async state() {
    const state = await this.request('/state')
    if (state.workerId !== this.id || (this.bootId && state.bootId !== this.bootId)) {
      throw new Error('Guest identity mismatch')
    }
    return state
  }

  async until(predicate, message, timeout = 5000) {
    const deadline = performance.now() + timeout
    do {
      const state = await this.state()
      if (predicate(state)) return state
      await delay(60)
    } while (performance.now() < deadline)
    throw new Error(`${this.id}: ${message}`)
  }

  async point(widget) {
    const state = await this.state()
    const bounds = state.bounds[widget]
    if (!bounds) throw new Error('Unknown fixture widget')
    const values = [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
    const limits = [state.screen.width, state.screen.height]
    if (values.some((value, index) => value < 0 || value >= limits[index])) throw new Error('Target outside guest display')
    await this.qmp('input-send-event', { events: ['x', 'y'].map((axis, index) => ({
      type: 'abs', data: { axis, value: Math.round(values[index] * 32767 / (limits[index] - 1)) },
    })) })
    await this.until(current => Math.abs(current.pointer.x - values[0]) <= 3
      && Math.abs(current.pointer.y - values[1]) <= 3, 'Virtual pointer did not reach its target')
  }

  async button(button) {
    const before = await this.state()
    try {
      await this.qmp('input-send-event', { events: [{ type: 'btn', data: { down: true, button } }] })
      await this.until(state => state.wheelEvents > before.wheelEvents, 'Virtual wheel event was not received')
    } finally {
      await this.qmp('input-send-event', { events: [{ type: 'btn', data: { down: false, button } }] })
    }
  }

  async click(widget) {
    await this.point(widget)
    const before = await this.state()
    try {
      await this.qmp('input-send-event', { events: [{ type: 'btn', data: { down: true, button: 'left' } }] })
      await this.until(state => state.pointerEvents > before.pointerEvents, 'Virtual button press was not received')
    } catch (error) {
      error.inputDiagnostic = { workerId: this.id, widget, before,
        pointerWhilePressed: await this.request('/pointer-state').catch(() => ({ unavailable: true })),
        stateWhilePressed: await this.state().catch(() => ({ unavailable: true })) }
      throw error
    } finally {
      await this.qmp('input-send-event', { events: [{ type: 'btn', data: { down: false, button: 'left' } }] })
    }
    await this.until(state => state.releaseEvents > before.releaseEvents, 'Virtual button release was not received')
  }

  async typeAscii(text) {
    if (!/^[a-z0-9 ]+$/.test(text)) throw new Error('ASCII test accepts lower-case letters, digits and spaces')
    for (const char of text) {
      for (const down of [true, false]) {
        await this.qmp('input-send-event', { events: [{
          type: 'key', data: { down, key: { type: 'qcode', data: char === ' ' ? 'spc' : char } },
        }] })
        await delay(25)
      }
    }
  }

  async screenshot(name) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid screenshot name')
    const filename = path.join(this.directory, `${name}.png`)
    const start = performance.now()
    await this.qmp('screendump', { filename, device: 'display0', format: 'png' })
    const png = await readFile(filename)
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid guest frame')
    return { filename, width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length,
      captureMs: Math.round(performance.now() - start) }
  }

  async stop() {
    this.closing = true
    if (!this.child) return
    if (!this.closed) await this.qmp('quit').catch(() => {})
    const result = await Promise.race([this.exited, delay(3000).then(() => null)])
    if (!result && !this.closed) {
      this.child.kill()
      await Promise.race([this.exited, delay(3000)])
    }
    if (!this.closed) throw new Error(`${this.id}: owned guest cleanup failed`)
    this.lines?.close()
  }
}
