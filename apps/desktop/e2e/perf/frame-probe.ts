import type { Page } from '@playwright/test'

export type ProbeData = { intervals: number[]; longtasks: number[]; events: { name: string; duration: number }[]; keydowns: number; mutations: number; elapsedMs: number }
type ProbeOptions = { mutationSelector?: string }
type ProbeWindow = Window & { __perfProbe?: { stop: () => ProbeData } }

// Runs in the renderer; must stay self-contained because Playwright serializes it.
function installProbe(opts: ProbeOptions): void {
  const w = window as ProbeWindow
  w.__perfProbe?.stop()
  const data: ProbeData = { intervals: [], longtasks: [], events: [], keydowns: 0, mutations: 0, elapsedMs: 0 }
  const started = performance.now()
  let running = true, last = -1, raf = 0
  const tick = (t: number) => {
    if (!running) return
    if (last >= 0) data.intervals.push(t - last)
    last = t
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(t => { last = t; raf = requestAnimationFrame(tick) })
  const tasks = new PerformanceObserver(list => { for (const e of list.getEntries()) data.longtasks.push(e.duration) })
  tasks.observe({ type: 'longtask', buffered: false })
  const events = new PerformanceObserver(list => { for (const e of list.getEntries()) data.events.push({ name: e.name, duration: e.duration }) })
  events.observe({ type: 'event', buffered: false, durationThreshold: 16 } as PerformanceObserverInit)
  const onKey = () => { data.keydowns++ }
  document.addEventListener('keydown', onKey, true)
  let mutations: MutationObserver | null = null
  if (opts.mutationSelector) {
    const target = document.querySelector(opts.mutationSelector)
    if (!target) throw new Error(`probe: no ${opts.mutationSelector}`)
    mutations = new MutationObserver(records => { data.mutations += records.length })
    mutations.observe(target, { childList: true, characterData: true, subtree: true })
  }
  w.__perfProbe = {
    stop: () => {
      running = false
      cancelAnimationFrame(raf)
      for (const e of events.takeRecords()) data.events.push({ name: e.name, duration: e.duration })
      for (const e of tasks.takeRecords()) data.longtasks.push(e.duration)
      if (mutations) { data.mutations += mutations.takeRecords().length; mutations.disconnect() }
      tasks.disconnect(); events.disconnect()
      document.removeEventListener('keydown', onKey, true)
      data.elapsedMs = performance.now() - started
      delete w.__perfProbe
      return data
    },
  }
}

export async function startProbe(page: Page, opts: ProbeOptions = {}): Promise<void> {
  await page.evaluate(installProbe, opts)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

export async function stopProbe(page: Page): Promise<ProbeData> {
  // Long task and event entries are delivered asynchronously; give them one task to land.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)))
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).__perfProbe
    if (!probe) throw new Error('probe: not installed')
    return probe.stop()
  })
}

export function frameP95(intervals: number[]): number {
  if (intervals.length < 5) throw new Error(`too few rAF intervals: ${intervals.length}`)
  const sorted = [...intervals].sort((a, b) => a - b)
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!
}

// Event Timing only reports entries ≥16 ms, so unreported keydowns are counted at that 16 ms upper bound.
export function keyEventDurations(data: ProbeData): number[] {
  if (data.keydowns === 0) throw new Error('probe: no keydown reached the renderer')
  const measured = data.events.filter(e => e.name === 'keydown').map(e => e.duration)
  return [...measured, ...Array<number>(Math.max(0, data.keydowns - measured.length)).fill(16)]
}

export const svgCount = (page: Page) => page.evaluate(() => document.querySelectorAll('.bot-avatar svg *, .comet-avatar svg *').length)

export const unpausedAnimations = (page: Page) => page.evaluate(() => document.getAnimations().filter(a => {
  const target = (a.effect as KeyframeEffect | null)?.target
  return target instanceof Element && !!target.closest('.comet-activity-icon, .bot-avatar, .comet-avatar') && a.playState !== 'paused'
}).length)

export type StreamWatch = { tokens: { at: number; text: string }[]; doneAt: number | null; doneText: string | null; settledAt: number | null }

// Attaches before the send; records each matching event's renderer time in the event callback itself.
export async function watchStream(page: Page, channel: string): Promise<void> {
  await page.evaluate((ch) => {
    const w = window as Window & { __perfStream?: StreamWatch & { off: () => void } }
    w.__perfStream?.off()
    const state: StreamWatch & { off: () => void } = { tokens: [], doneAt: null, doneText: null, settledAt: null, off: () => undefined }
    state.off = window.engram.onEvent(event => {
      if (!('channel' in event) || event.channel !== ch) return
      if (event.type === 'chat:token') state.tokens.push({ at: performance.now(), text: event.text })
      if (event.type === 'chat:done') { state.doneAt = performance.now(); state.doneText = event.text }
    })
    w.__perfStream = state
  }, channel)
}

// Resolves when the last assistant bubble holds the full reply, is out of streaming state, and one more frame has painted.
export async function awaitSettled(page: Page, sentinel: string, timeoutMs: number): Promise<StreamWatch> {
  return page.evaluate(({ sentinel, timeoutMs }) => new Promise<StreamWatch>((resolve, reject) => {
    const w = window as Window & { __perfStream?: StreamWatch & { off: () => void } }
    const state = w.__perfStream
    if (!state) { reject(new Error('stream watch not installed')); return }
    const deadline = performance.now() + timeoutMs
    const check = () => {
      const bubbles = document.querySelectorAll('[data-testid="bots-thread"] .bubble-msg.assistant')
      const last = bubbles[bubbles.length - 1]
      const settled = state.doneAt !== null && last && last.querySelector('.answer-actions') && (last.textContent ?? '').includes(sentinel)
      if (settled) {
        requestAnimationFrame(() => { state.settledAt = performance.now(); state.off(); resolve({ tokens: state.tokens, doneAt: state.doneAt, doneText: state.doneText, settledAt: state.settledAt }) })
        return
      }
      if (performance.now() > deadline) { state.off(); reject(new Error(`final bubble not rendered: ${state.tokens.length} tokens, done ${state.doneAt !== null}`)); return }
      requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  }), { sentinel, timeoutMs })
}

// Scrolls the bot thread to its top and returns how far the top bubble moved when the earlier page landed.
export async function measureAnchor(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const thread = document.querySelector('[data-testid="bots-thread"]')
    if (!thread) { reject(new Error('P4: no bots-thread')); return }
    const frame = () => new Promise(done => requestAnimationFrame(() => done(undefined)))
    const count = () => thread.querySelectorAll('.bubble-msg').length
    void (async () => {
      // Leave the top first so reaching it is a fresh top reach even after the wheel probe ended there.
      thread.scrollTop = 40
      await frame(); await frame()
      thread.scrollTop = 0
      const edge = thread.getBoundingClientRect().top
      const anchor = [...thread.querySelectorAll('.bubble-msg')].find(el => el.getBoundingClientRect().top >= edge)
      if (!anchor) { reject(new Error('P4: no bubble at the top')); return }
      const oldTop = anchor.getBoundingClientRect().top, before = count(), deadline = performance.now() + 5000
      while (count() <= before) {
        if (performance.now() > deadline) { reject(new Error('P4: no earlier page loaded')); return }
        await frame()
      }
      await frame(); await frame()
      resolve(Math.abs(anchor.getBoundingClientRect().top - oldTop))
    })()
  }))
}
