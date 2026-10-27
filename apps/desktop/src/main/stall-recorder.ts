import { app, type WebContents } from 'electron'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { flog } from './flog.js'

// The window's script is sampled lightly all the time, a minute at a time.
// A minute that held a stall of seconds is kept as a profile beside the log,
// so a freeze on a person's machine names the code that held it.
const WINDOW_MS = 60_000
const SAMPLE_US = 10_000
const WORTH_MS = 2_000
const KEPT = 6

export function recordStalls(contents: WebContents): (ms: number) => void {
  const forced = process.env['ENGRAM_STALL_PROFILE'] === '1'
  if (!forced && (!app.isPackaged || process.env['ENGRAM_USERDATA'])) return () => undefined
  const dir = join(app.getPath('userData'), 'logs')
  const debug = contents.debugger
  let longest = 0
  let timer: NodeJS.Timeout | undefined
  const start = async (): Promise<void> => {
    await debug.sendCommand('Profiler.enable')
    await debug.sendCommand('Profiler.setSamplingInterval', { interval: SAMPLE_US })
    await debug.sendCommand('Profiler.start')
  }
  const keep = async (held: number, profiles: unknown[]): Promise<void> => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const names = profiles.map((_, index) => `renderer-stall-${stamp}-${index + 1}.cpuprofile`)
    await Promise.all(profiles.map((profile, index) => writeFile(join(dir, names[index]!), JSON.stringify(profile))))
    flog('renderer-stall', `${held}ms kept as ${names.join(', ')}`)
    const kept = (await readdir(dir)).filter(file => file.startsWith('renderer-stall-')).sort()
    for (const old of kept.slice(0, -KEPT)) await rm(join(dir, old), { force: true })
  }
  // A stall is reported once it is over, so it often lands in the window after
  // the one that sampled it: that window is kept with it. One turn at a time -
  // a stop sent during a stall answers only when the stall ends.
  let previous: unknown
  let turning = false
  const turn = async (): Promise<void> => {
    if (turning || contents.isDestroyed() || !debug.isAttached()) return
    turning = true
    try {
      const { profile } = await debug.sendCommand('Profiler.stop') as { profile: unknown }
      await start()
      const held = longest
      longest = 0
      if (held >= WORTH_MS) await keep(held, previous ? [previous, profile] : [profile])
      previous = held >= WORTH_MS ? undefined : profile
    } catch (error) {
      flog('renderer-stall', error)
      previous = undefined
      await start().catch(() => undefined)
    } finally {
      turning = false
    }
  }
  try {
    debug.attach('1.3')
  } catch (error) {
    flog('renderer-stall', `not recording: ${error instanceof Error ? error.message : String(error)}`)
    return () => undefined
  }
  void start().then(() => {
    timer = setInterval(() => void turn(), WINDOW_MS)
  }, error => flog('renderer-stall', error))
  contents.once('destroyed', () => clearInterval(timer))
  debug.once('detach', () => clearInterval(timer))
  return (ms) => { longest = Math.max(longest, Math.round(ms)) }
}
