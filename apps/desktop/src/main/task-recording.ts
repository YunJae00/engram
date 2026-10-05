import { createHash } from 'node:crypto'
import { saveArtifact } from 'core'
import { lanePage } from './agent-browser.js'
import { videoEncoder } from './evidence-video.js'
import { flog } from './flog.js'
import { maskedFrame } from './masked-frame.js'

// What a comet's browser showed while it worked, kept as a short video the
// person can watch to see what was done. It costs nothing when the turn never
// opens a page; frames are taken only while the picture changes, and fields
// a page declares secret are blacked out before a frame is kept.

const FRAME_MS = 1_500
// A still screen is written again now and then so the video keeps time.
const HOLD_MS = 10_000
const MAX_FRAMES = 900
const BITS_PER_SECOND = 600_000
// Final capture, cold encoder startup and MP4 flush share this budget.
// Individual operations are bounded separately; user cancellation is immediate.
const STOP_MS = 30_000

export interface TaskRecording {
  observe(): void
  stop(options?: { captureFinal?: boolean }): Promise<string | null>
}
const active = new Set<TaskRecording>()
let enabled = true
export async function stopTaskRecordings(): Promise<void> {
  await Promise.all([...active].map(recording => recording.stop({ captureFinal: false })))
}
export function setTaskRecordingsEnabled(value: boolean): Promise<void> {
  enabled = value
  return value ? Promise.resolve() : stopTaskRecordings()
}

export function startTaskRecording(lane: string, directory: string, signal?: AbortSignal): TaskRecording {
  let encoder: Awaited<ReturnType<typeof videoEncoder>> | null = null
  let starting: Promise<void> | null = null
  let frames = 0, lastHash = '', lastAt = 0, stopped = false, broken = false, told = false, observed = false, finished = false
  let inflight: Promise<void> | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  const capture = new AbortController()
  const canceled = new Promise<null>(resolve => capture.signal.addEventListener('abort', () => resolve(null), { once: true }))
  const closeEncoder = () => {
    const held = encoder
    encoder = null
    try { held?.close() } catch (error) { flog('task-recording', `encoder close: ${String(error)}`) }
  }
  const startedAt = new Date()
  const take = async (): Promise<void> => {
    const page = lanePage(lane)
    if (!page || page.isClosed() || broken) return
    const data = await maskedFrame(page, new URL(page.url()).origin, [], capture.signal, undefined, 'jpeg', 60)
    if (lanePage(lane) !== page) return
    const hash = createHash('sha1').update(data).digest('hex')
    if (hash === lastHash && Date.now() - lastAt < HOLD_MS) return
    if (!encoder) {
      starting ??= videoEncoder({ width: 1280, height: 720 }, BITS_PER_SECOND).then(made => { encoder = made; if (capture.signal.aborted) closeEncoder() })
      await starting
    }
    capture.signal.throwIfAborted()
    if (!encoder) return
    await encoder.frame(data, 'image/jpeg')
    capture.signal.throwIfAborted()
    frames++; lastHash = hash; lastAt = Date.now()
    if (frames >= MAX_FRAMES) clearInterval(timer)
  }
  // A frame that cannot be taken (a page mid-navigation, a closed tab) is skipped, not fatal.
  const attempt = (): Promise<void> => take().catch(error => {
    if (capture.signal.aborted) return
    if (/Recording|encod|MP4/i.test(String(error))) broken = true
    if (!told) { told = true; flog('task-recording', `frame skipped: ${String(error)}`) }
  })
  const tick = (): void => {
    if (inflight || stopped) return
    inflight = attempt().finally(() => { inflight = null })
  }
  let stopping: Promise<string | null> | null = null
  const abort = () => { void recording.stop({ captureFinal: false }) }
  const recording: TaskRecording = {
    observe() {
      if (stopped || observed || !enabled) return
      observed = true
      timer = setInterval(tick, FRAME_MS)
      timer.unref()
    },
    stop(options) {
      stopped = true
      clearInterval(timer)
      if (options?.captureFinal === false && !finished) { capture.abort(); closeEncoder() }
      if (stopping) return stopping
      const timeout = setTimeout(() => {
        flog('task-recording', `finalization timed out after ${STOP_MS}ms (${frames} frames)`)
        capture.abort(); closeEncoder()
      }, STOP_MS)
      const save = (async () => {
        try {
          await inflight
          capture.signal.throwIfAborted()
          // A text-only turn never captures a retained tab; cancellation never
          // takes a final screenshot or saves a newly pending frame.
          if (observed && frames < MAX_FRAMES) await attempt()
          capture.signal.throwIfAborted()
          const held = encoder as Awaited<ReturnType<typeof videoEncoder>> | null
          if (!held || !frames) return null
          const data = await held.finish()
          capture.signal.throwIfAborted()
          const name = `task-recording-${startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`
          return (await saveArtifact(directory, name, data, capture.signal, true)).markdownLink
        } catch (error) {
          if (!capture.signal.aborted) flog('task-recording', `${frames} frames: ${String(error)}`)
          return null
        }
      })()
      stopping = Promise.race([save, canceled]).finally(() => {
        finished = true; clearTimeout(timeout); closeEncoder(); active.delete(recording); signal?.removeEventListener('abort', abort)
      })
      return stopping
    },
  }
  active.add(recording)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted || !enabled) abort()
  return recording
}
