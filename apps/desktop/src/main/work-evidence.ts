import { app, dialog, ipcMain, nativeImage, shell } from 'electron'
import { basename, extname } from 'node:path'
import { evidenceRegion, evidenceTools, readArtifact, resolveArtifact, saveArtifact, type VaultPaths } from 'core'
import type { Page } from 'playwright-core'
import { agentPage, readAgentPage } from './agent-browser.js'
import { artifactDirectory } from './file-work.js'
import { handOn } from './page-actions.js'
import { videoEncoder } from './evidence-video.js'
import { broadcast } from './engine-health.js'

const SECRET = 'input[type="password"], [autocomplete^="cc-"], [autocomplete="one-time-code"], [autocomplete="current-password"], [autocomplete="new-password"]'
type Recording = { lane: string; started: number; frames: number; stop(reason?: string): Promise<unknown> }
const recordings = new Map<string, Recording>()
const completed = new Map<string, unknown>()
export const evidenceStatus = (lane: string) => { const value = recordings.get(lane); return value ? { lane, started: value.started, frames: value.frames } : null }
const changed = (lane: string, reason?: string) => broadcast({ type: 'evidence:recording', lane, recording: evidenceStatus(lane), ...(reason ? { reason: reason.slice(0, 300) } : {}) })
export async function stopEvidenceRecording(lane: string, reason?: string): Promise<unknown> {
  return recordings.get(lane)?.stop(reason) ?? completed.get(lane) ?? { recording: 'not-started' }
}

async function approve(message: string, detail: string, signal?: AbortSignal, preview?: string): Promise<void> {
  signal?.throwIfAborted()
  while (true) {
    const result = await dialog.showMessageBox({ type: 'question', message, detail, buttons: preview ? ['Cancel', 'Preview file', 'Allow once'] : ['Cancel', 'Allow once'], defaultId: 0, cancelId: 0, ...(signal ? { signal } : {}) })
    signal?.throwIfAborted()
    if (preview && result.response === 1) { const error = await shell.openPath(preview); if (error) throw new Error(error); continue }
    if (result.response !== (preview ? 2 : 1)) throw new Error('The person declined. Stop; do not retry through another tool.')
    return
  }
}

function expected(page: Page, url: unknown): string {
  if (typeof url !== 'string') throw new Error('Supply the exact current page URL.')
  const parsed = new URL(url)
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href !== page.url()) throw new Error('The current page does not match the approved URL. Observe it again.')
  return parsed.href
}

// A still is kept lossless; a video frame is re-encoded by the recorder
// anyway, so it travels as JPEG - a fraction of the bytes crossing into the
// encoder window per frame.
async function maskedFrame(page: Page, origin: string, masks: string[], signal?: AbortSignal, region?: unknown, format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
  signal?.throwIfAborted()
  if (page.isClosed() || new URL(page.url()).origin !== origin) throw new Error('The recorded tab closed or left the approved site.')
  const frames = page.frames()
  const addresses = frames.map(frame => frame.url())
  // Failure to inspect any frame must not fall back to an unmasked image.
  for (const frame of frames) await frame.locator('html').count()
  for (const selector of masks) {
    const counts = await Promise.all(frames.map(frame => frame.locator(selector).count()))
    if (!counts.some(Boolean)) throw new Error('A requested redaction target is missing. Recording stopped before capturing it.')
  }
  const data = await page.screenshot({ type: format, ...(format === 'jpeg' ? { quality: 80 } : {}), fullPage: false, scale: 'css', timeout: 8000, mask: frames.flatMap(frame => [frame.locator(SECRET), ...masks.map(selector => frame.locator(selector))]), maskColor: '#202020' })
  signal?.throwIfAborted()
  if (new URL(page.url()).origin !== origin || frames.length !== page.frames().length || frames.some((frame, i) => frame.isDetached() || frame.url() !== addresses[i])) throw new Error('The page changed while capturing evidence.')
  if (!region) return data
  const image = nativeImage.createFromBuffer(data)
  const size = image.getSize()
  const cropped = image.crop(evidenceRegion(region, size.width, size.height)!)
  return format === 'jpeg' ? cropped.toJPEG(80) : cropped.toPNG()
}

export function workEvidenceTools(paths: VaultPaths, lane: string) {
  const directory = artifactDirectory(paths)
  let declined = false
  const consent = async (...args: Parameters<typeof approve>) => {
    if (declined) throw new Error('Evidence permission was declined. Stop this task.')
    try { await approve(...args) } catch (error) { declined = true; throw error }
  }
  const prepare = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    const page = await agentPage(signal, lane)
    const url = expected(page, args.url)
    if (typeof args.name !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,79}$/u.test(args.name)) throw new Error('Use a short plain evidence name without directories.')
    const masks = args.masks ?? []
    const viewport = args.region ? await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) : undefined
    const region = evidenceRegion(args.region, viewport?.width ?? 0, viewport?.height ?? 0)
    if (!Array.isArray(masks) || masks.length > 12 || masks.some(value => typeof value !== 'string' || value.length > 300)) throw new Error('Provide up to 12 CSS redaction selectors.')
    return { page, url, origin: new URL(url).origin, masks: masks as string[], name: args.name, region }
  }
  const save = async (name: string, data: Buffer, metadata: object, signal?: AbortSignal) => {
    const artifact = await saveArtifact(directory, name, data, signal, true)
    const provenance = await saveArtifact(directory, `${name}.json`, Buffer.from(JSON.stringify({ ...metadata, artifact: artifact.artifact, sha256: artifact.sha256, capturedAt: new Date().toISOString(), privacy: 'Declared secret fields and requested selectors masked. Review for other sensitive content before sharing.' }, null, 2)), signal)
    return { ...artifact, provenance: provenance.markdownLink }
  }
  return evidenceTools({
    read: async signal => readAgentPage(await agentPage(signal, lane), signal),
    async capture(args, signal) {
      const source = await prepare(args, signal)
      await consent('Save a screenshot of this browser tab?', `${source.url}\n\n${source.region ? `Region: ${JSON.stringify(source.region)} (viewport pixels).` : 'Whole visible tab.'} Review for sensitive content before sharing.`, signal)
      expected(source.page, source.url)
      return save(`${source.name}.png`, await maskedFrame(source.page, source.origin, source.masks, signal, source.region), { ...args, lane, url: source.url }, signal)
    },
    async start(args, signal) {
      if (recordings.has(lane)) throw new Error('A recording is already active in this chat. Stop it first.')
      completed.delete(lane)
      const source = await prepare(args, signal)
      await consent('Record this browser tab?', `${source.url}\n\n${source.region ? `Fixed region: ${JSON.stringify(source.region)} (viewport pixels). It does not follow elements when scrolling.` : 'Whole visible tab.'}\nSilent recording, up to 120 seconds. Only this tab; other windows and new tabs are excluded. Declared secret fields are masked, but other sensitive content requires review.`, signal)
      expected(source.page, source.url)
      const encoder = await videoEncoder(source.region)
      let active = true, stopping: Promise<unknown> | undefined, pending = Promise.resolve()
      const state: Recording = { lane, started: Date.now(), frames: 0, stop: reason => {
        if (stopping) return stopping
        active = false; clearInterval(timer); clearTimeout(limit); signal?.removeEventListener('abort', abort); source.page.off('close', closed)
        stopping = (async () => {
          try {
            await pending
            const data = await encoder.finish()
            const result = { recording: reason ? 'interrupted' : 'saved', name: source.name, url: source.url, reason, frames: state.frames, durationMs: Date.now() - state.started, ...await save(`${source.name}.mp4`, data, { ...args, lane, url: source.url, reason, frames: state.frames }) }
            completed.set(lane, result)
            if (completed.size > 50) completed.delete(completed.keys().next().value!)
            return result
          } catch (error) { reason ??= 'The recording could not be saved.'; throw error }
          finally { encoder.close(); recordings.delete(lane); changed(lane, reason) }
        })()
        return stopping
      } }
      const capture = async () => { const data = await maskedFrame(source.page, source.origin, source.masks, signal, source.region, 'jpeg'); if (active) { await encoder.frame(data, 'image/jpeg'); state.frames++ } }
      const tick = () => {
        if (!active || capturing) return
        capturing = true
        pending = capture().catch(error => { void state.stop(error instanceof Error ? error.message : 'Capture failed').catch(() => {}) }).finally(() => { capturing = false })
      }
      let capturing = false
      const timer = setInterval(tick, 250)
      const limit = setTimeout(() => { void state.stop('Recording time limit reached').catch(() => {}) }, Math.min(120, Math.max(1, Number(args.maxSeconds) || 120)) * 1000)
      const abort = () => { void state.stop('Task stopped').catch(() => {}) }
      const closed = () => { void state.stop('Recorded tab closed').catch(() => {}) }
      recordings.set(lane, state); changed(lane)
      signal?.addEventListener('abort', abort, { once: true }); source.page.once('close', closed)
      capturing = true
      pending = capture().finally(() => { capturing = false })
      try { await pending } catch (error) { await state.stop('Initial capture failed').catch(() => {}); throw error }
      if (!active) throw new Error('Recording stopped before it was ready.')
      if (signal?.aborted) abort()
      signal?.throwIfAborted()
      return { recording: 'started', url: source.url, maxSeconds: Math.min(120, Math.max(1, Number(args.maxSeconds) || 120)), message: 'Recording this tab only. Call record_stop before finishing; inspect the saved video before uploading.' }
    },
    stop: signal => { signal?.throwIfAborted(); return stopEvidenceRecording(lane) },
    async upload(args, signal) {
      const page = await agentPage(signal, lane)
      const url = expected(page, args.url)
      const path = await resolveArtifact(directory, args.artifact)
      const extension = extname(path).toLowerCase()
      if (!['.png', '.mp4', '.webm', '.pdf', '.txt', '.csv', '.xlsx', '.docx', '.pptx'].includes(extension)) throw new Error('This artifact type cannot be uploaded.')
      const data = await readArtifact(directory, String(args.artifact), signal)
      const target = String(args.target ?? '')
      const confirmation = String(args.confirmation ?? '')
      if (!target || !confirmation || confirmation.length > 2000) throw new Error('Provide the file input and expected attachment confirmation text.')
      if (await page.getByText(confirmation, { exact: true }).filter({ visible: true }).count()) throw new Error('Confirmation already exists. Inspect the existing attachment; do not upload a duplicate.')
      const labeled = page.frames().map(frame => frame.getByLabel(target, { exact: true }).and(frame.locator('input[type="file"]')))
      const counts = await Promise.all(labeled.map(locator => locator.count()))
      const aim = counts.reduce((sum, count) => sum + count, 0) === 1 ? { hand: labeled[counts.findIndex(count => count === 1)]! } : await handOn(page, target, signal)
      if (!('hand' in aim) || !await aim.hand.evaluate(el => el instanceof HTMLInputElement && el.type === 'file')) throw new Error('Choose one file input by its exact label or a visible control number.')
      await consent('Upload this file to this page?', `${basename(path).slice(37)}\n${url}\n\nFile selection can immediately send its contents. Preview the file and verify the destination before allowing.`, signal, path)
      signal?.throwIfAborted(); expected(page, url)
      if (await resolveArtifact(directory, args.artifact) !== path) throw new Error('The artifact changed.')
      if (!(await readArtifact(directory, String(args.artifact), signal)).equals(data)) throw new Error('The approved artifact changed.')
      signal?.throwIfAborted(); expected(page, url)
      await aim.hand.setInputFiles({ name: basename(path).slice(37), mimeType: extension === '.mp4' ? 'video/mp4' : extension === '.webm' ? 'video/webm' : extension === '.png' ? 'image/png' : 'application/octet-stream', buffer: data }, { timeout: 10000 })
      let confirmed = false
      try { await page.getByText(confirmation, { exact: true }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 15000 }); confirmed = page.url() === url && !signal?.aborted } catch { /* Selection may already have sent the file; never retry automatically. */ }
      return { upload: { status: confirmed ? 'confirmed' : 'unconfirmed', artifact: args.artifact, url, confirmation, bytes: data.length }, message: confirmed ? 'The specified confirmation appeared. Verify that it identifies the saved attachment, not a pending preview.' : 'File selection was dispatched, but completion is unconfirmed. Inspect before any retry.' }
    },
  })
}

export function registerEvidenceIpc() {
  ipcMain.handle('evidence:status', () => [...recordings.keys()].map(lane => evidenceStatus(lane)!))
  ipcMain.handle('evidence:stop', (_event, lane: string) => stopEvidenceRecording(lane))
  app.on('before-quit', () => { for (const value of recordings.values()) void value.stop('App closing').catch(() => {}) })
}
