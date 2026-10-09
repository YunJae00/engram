import { dialog, shell } from 'electron'
import { basename, extname } from 'node:path'
import { evidenceRegion, evidenceTools, readArtifact, resolveArtifact, saveArtifact, type VaultPaths } from 'core'
import type { Page } from 'playwright-core'
import { agentPage, readAgentPage } from './agent-browser.js'
import { artifactDirectory } from './file-work.js'
import { handOn } from './page-actions.js'
import { maskedFrame } from './masked-frame.js'

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
