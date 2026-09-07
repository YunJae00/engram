import { monitorEventLoopDelay } from 'node:perf_hooks'
import { freemem } from 'node:os'
import { app, powerMonitor } from 'electron'
import { flog } from './flog.js'

export function logResponsiveness(tag: string, delayMs?: number): void {
  const memory = process.memoryUsage()
  flog(tag, JSON.stringify({ delayMs, freeMB: Math.round(freemem() / 1e6), rssMB: Math.round(memory.rss / 1e6), heapMB: Math.round(memory.heapUsed / 1e6) }))
}

export function watchResponsiveness(): void {
  const delay = monitorEventLoopDelay({ resolution: 100 })
  delay.enable()
  let lastReport = 0
  const reset = () => delay.reset()
  powerMonitor.on('resume', reset)
  const timer = setInterval(() => {
    const lag = Math.round(delay.max / 1e6)
    delay.reset()
    if (lag < 2000 || Date.now() - lastReport < 60_000) return
    lastReport = Date.now()
    logResponsiveness('main-loop-delay', lag)
  }, 15_000).unref()
  app.once('will-quit', () => {
    clearInterval(timer)
    delay.disable()
    powerMonitor.off('resume', reset)
  })
}
