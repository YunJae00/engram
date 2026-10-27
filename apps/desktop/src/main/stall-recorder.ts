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
const KEPT = 4

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
  const turn = async (): Promise<void> => {
    if (contents.isDestroyed() || !debug.isAttached()) return
    const { profile } = await debug.sendCommand('Profiler.stop') as { profile: unknown }
    const held = longest
    longest = 0
    await start()
    if (held < WORTH_MS) return
    const name = `renderer-stall-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`
    await writeFile(join(dir, name), JSON.stringify(profile))
    flog('renderer-stall', `${held}ms kept as ${name}`)
    const kept = (await readdir(dir)).filter(file => file.startsWith('renderer-stall-')).sort()
    for (const old of kept.slice(0, -KEPT)) await rm(join(dir, old), { force: true })
  }
  try {
    debug.attach('1.3')
  } catch (error) {
    flog('renderer-stall', `not recording: ${error instanceof Error ? error.message : String(error)}`)
    return () => undefined
  }
  void start().then(() => {
    timer = setInterval(() => void turn().catch(error => flog('renderer-stall', error)), WINDOW_MS)
  }, error => flog('renderer-stall', error))
  contents.once('destroyed', () => clearInterval(timer))
  debug.once('detach', () => clearInterval(timer))
  return (ms) => { longest = Math.max(longest, Math.round(ms)) }
}
