import type { AgentLoopStep, AgentTool } from './agent-loop.js'
import type { WebPage } from './errand.js'

export interface PageCheck {
  id: string; url: string; ready: string; present?: string[]; absent?: string[]; timeoutMs?: number
}
const text = { type: 'string', minLength: 1, maxLength: 2000 }
const words = { type: 'array', items: text, maxItems: 12 }
const schema = (properties: object, required: string[]) => ({ type: 'object', additionalProperties: false, properties, required })
const checkSchema = schema({ id: text, url: text, ready: text, present: words, absent: words, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 } }, ['id', 'url', 'ready'])

export function checkPage(page: WebPage, check: PageCheck) {
  const content = [page.title, page.text, ...(page.controls ?? [])].join('\n')
  const base = { id: check.id, url: page.url, at: new Date().toISOString() }
  if (new URL(page.url).href !== new URL(check.url).href || page.wall || !content.includes(check.ready)) return { ...base, status: 'inconclusive', reason: 'The expected page and ready state were not established.' }
  if (check.absent?.length && /\[Page extract truncated;/.test(page.text)) return { ...base, status: 'inconclusive', reason: 'A truncated page extract cannot establish absence.' }
  const missing = (check.present ?? []).filter(word => !content.includes(word))
  const unexpected = (check.absent ?? []).filter(word => content.includes(word))
  return { ...base, status: missing.length || unexpected.length ? 'failed' : 'passed', missing, unexpected, scope: 'Visible text only; not visual, behavioral, or whole-task correctness.' }
}

export function evidenceFault(steps: AgentLoopStep[]): string | undefined {
  const checks = new Map<string, boolean>()
  const recordings = new Set<string>()
  const recordingKey = (name: unknown, url: unknown) => {
    try { return JSON.stringify([name, new URL(String(url)).href]) }
    catch { return JSON.stringify([name, url]) }
  }
  for (const step of steps) {
    if (!step.seeded && step.tool === 'record_start') recordings.add(recordingKey(step.args.name, step.args.url))
    if (!step.seeded && step.tool === 'record_stop') {
      try {
        const receipt = JSON.parse(step.observation)
        if (receipt.recording === 'saved' && typeof receipt.name === 'string' && typeof receipt.url === 'string' && typeof receipt.artifact === 'string' && receipt.frames > 0) recordings.delete(recordingKey(receipt.name, receipt.url))
      } catch { /* Unconfirmed recording remains outstanding. */ }
    }
    if (!['verify', 'wait_for', 'upload_file'].includes(step.tool) || step.seeded) continue
    const key = JSON.stringify(step.tool === 'upload_file' ? ['upload', step.args.artifact, step.args.url, step.args.target, step.args.confirmation] : ['check', step.args.id, step.args.url, step.args.ready, step.args.present, step.args.absent])
    try { const receipt = JSON.parse(step.observation); checks.set(key, step.tool === 'upload_file' ? receipt.upload?.status === 'confirmed' : receipt.verification?.status === 'passed') }
    catch { checks.set(key, false) }
  }
  return recordings.size ? 'A requested recording has not been saved successfully. Stop it and report any interruption before claiming completion.' : [...checks.values()].some(passed => !passed) ? 'A requested page check or upload has not been confirmed. Report the failed or inconclusive result; do not claim completion.' : undefined
}

export interface EvidenceHost {
  read(signal?: AbortSignal): Promise<WebPage>
  capture(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  start(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  stop(signal?: AbortSignal): Promise<unknown>
  upload(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

export function evidenceTools(host: EvidenceHost): AgentTool[] {
  const inspect = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    const check = args as unknown as PageCheck
    if (!check.id || !check.ready || !/^https?:\/\//.test(check.url)) throw new Error('Provide a check id, exact http(s) URL, and positive ready-state text.')
    const deadline = Date.now() + Math.min(30000, Math.max(0, Number(check.timeoutMs) || 0))
    while (true) {
      signal?.throwIfAborted()
      const verification = checkPage(await host.read(signal), check)
      signal?.throwIfAborted()
      if (verification.status === 'passed' || Date.now() >= deadline) return JSON.stringify({ verification })
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Stopped')) }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, Math.min(500, Math.max(0, deadline - Date.now())))
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    }
  }
  const captureSchema = schema({ name: { ...text, maxLength: 80 }, url: text, masks: { type: 'array', items: { ...text, maxLength: 300 }, maxItems: 12 }, issue: text, build: text, role: text, testData: text, maxSeconds: { type: 'integer', minimum: 1, maximum: 120 } }, ['name', 'url'])
  return [
    { name: 'wait_for', description: 'Wait up to 30 seconds for an exact page URL, positive ready text and optional present/absent text. Returns passed, failed or inconclusive. Loading, login and truncated extracts are not proof of absence.', argsSchema: checkSchema, run: (args, context) => inspect({ ...args, timeoutMs: args.timeoutMs ?? 15000 }, context.signal) },
    { name: 'verify', description: 'Check a fresh page against an explicit ready state and expected present/absent text. Use stable check ids; repeat failed checks after correction. Record build, account role and test data with evidence. Absence alone never proves a fix.', argsSchema: checkSchema, run: (args, context) => inspect(args, context.signal) },
    { name: 'capture_evidence', description: 'Save a reviewed, masked PNG of the current Engram browser page with source metadata. Supply optional CSS selectors for additional redaction. Content is not automatically proven safe; requires human review before sharing. Returns an artifact link.', argsSchema: captureSchema, run: async (args, context) => JSON.stringify(await host.capture(args, context.signal)) },
    { name: 'record_start', description: 'Ask to record this exact browser tab before reproduction actions. Saves a bounded silent WebM (max 120 seconds) with masked frames and source/build metadata. Does not record other windows or follow new tabs. Call record_stop before finishing. Review evidence before uploading.', argsSchema: captureSchema, run: async (args, context) => JSON.stringify(await host.start(args, context.signal)) },
    { name: 'record_stop', description: 'Stop and save the current browser recording. Returns its artifact, provenance and any interruption. A recording is evidence, not a pass/fail verdict.', argsSchema: schema({}, []), run: async (_args, context) => JSON.stringify(await host.stop(context.signal)) },
    { name: 'upload_file', description: 'Upload an Engram-generated artifact to one exact page and file input, only after file/destination approval. File selection may immediately transmit data. Supply visible confirmation text expected only after upload; inspect the returned confirmation and never blindly retry an uncertain upload.', argsSchema: schema({ artifact: text, url: text, target: text, confirmation: text }, ['artifact', 'url', 'target', 'confirmation']), run: async (args, context) => JSON.stringify(await host.upload(args, context.signal)) },
  ]
}
