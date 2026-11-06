import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

export function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

export class Semaphore {
  constructor(max, root) {
    this.max = max
    this.path = join(root, 'orchestration/logs/slots.json')
    let slots = []
    try {
      slots = JSON.parse(readFileSync(this.path, 'utf8')).slots ?? []
    } catch {
      slots = []
    }
    this.slots = slots.filter((s) => alive(s.pid))
    this.save()
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ max: this.max, slots: this.slots }, null, 2))
    renameSync(tmp, this.path)
  }

  free() {
    this.slots = this.slots.filter((s) => alive(s.pid))
    return this.max - this.slots.length
  }

  acquire(label, pid) {
    if (this.free() <= 0) return false
    this.slots.push({ pid, label, since: new Date().toISOString() })
    this.save()
    return true
  }

  release(pid) {
    this.slots = this.slots.filter((s) => s.pid !== pid)
    this.save()
  }
}
