import { app } from 'electron'
import { execFile } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { OfficeOp } from 'core'
import { planOfficeEdits, type OfficeText } from './office-edit-plan.js'
import { DesktopHost } from './desktop-host.js'

const reads = new Map<string, { file: string; kind: 'word' | 'ppt'; content: OfficeText[]; digest: string }>()
const running = new Set<AbortController>()
const script = (): string => app.isPackaged ? join(process.resourcesPath, 'bin', 'desktop', 'Office.js')
  : fileURLToPath(new URL('../../native/macos/Office.js', import.meta.url))
const digest = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex')

export function closeMacOffice(): void {
  for (const controller of running) controller.abort()
  reads.clear()
}

export async function macOfficeRequest(op: OfficeOp, args: Record<string, unknown>, signal?: AbortSignal,
  activity?: (window: string, name: string) => Promise<void>, assertActive?: () => void): Promise<unknown> {
  signal?.throwIfAborted()
  assertActive?.()
  if (op === 'probe') return Object.fromEntries(['Excel', 'Word', 'PowerPoint', 'Outlook'].map(name => [name.toLowerCase(),
    ['/Applications', join(homedir(), 'Applications')].some(root => existsSync(join(root, `Microsoft ${name}.app`)))]))
  const controller = new AbortController()
  running.add(controller)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const guard = assertActive ? setInterval(() => { try { assertActive() } catch { controller.abort() } }, 100) : undefined
  const directory = await mkdtemp(join(tmpdir(), 'engram-office-'))
  const call = async (operation: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    controller.signal.throwIfAborted()
    assertActive?.()
    const file = join(directory, 'request.json')
    await writeFile(file, JSON.stringify({ op: operation, args: input }), { mode: 0o600 })
    const output = await new Promise<string>((resolve, reject) => execFile('/usr/bin/osascript', ['-l', 'JavaScript', script(), file],
      { encoding: 'utf8', timeout: 90_000, maxBuffer: 2_000_000, signal: controller.signal }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Office automation failed: ${stderr.trim() || error.message}. Read the document before retrying a write; changes may be partial.`))
        else resolve(stdout)
      }))
    controller.signal.throwIfAborted()
    const result: unknown = JSON.parse(output)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Office response.')
    return result as Record<string, unknown>
  }
  try {
    const kind = op.startsWith('word.') ? 'word' : op.startsWith('ppt.') ? 'ppt' : undefined
    let input = { ...args }
    let source: string | undefined, disk: string | undefined
    let content: OfficeText[] | undefined
    if (kind) {
      if (typeof args['file'] !== 'string' || !isAbsolute(args['file']) || extname(args['file']).toLowerCase() !== (kind === 'word' ? '.docx' : '.pptx')) throw new Error('Use an absolute supported document path.')
      source = args['file']
      const info = await stat(source)
      if (!info.isFile() || info.size > 52_428_800) throw new Error('Document must be a file no larger than 50 MB.')
      disk = await digest(source)
      if (op.endsWith('.edit')) {
        const revision = String(args['revision'])
        const observed = reads.get(revision)
        reads.delete(revision)
        if (!observed || observed.file !== source || observed.kind !== kind || observed.digest !== disk) throw new Error('Read this document again before editing.')
        content = observed.content
        input = { ...input, expected: content, plan: planOfficeEdits(content, args['edits'] as Record<string, unknown>[], kind) }
      }
    }
    const saveAs = args['saveAs']
    if (saveAs !== undefined) {
      if (typeof saveAs !== 'string' || !isAbsolute(saveAs) || existsSync(saveAs) || args['save'] === true || !(await stat(dirname(saveAs))).isDirectory()) throw new Error('Save-as requires a new absolute path in an existing folder.')
      if (kind && extname(saveAs).toLowerCase() !== extname(source!).toLowerCase()) throw new Error('Save-as must preserve the document format.')
      if (op === 'excel.write' && extname(saveAs).toLowerCase() !== '.xlsx') throw new Error('Save an Excel workbook as .xlsx.')
    }
    if (activity && op !== 'excel.workbooks' && !op.startsWith('outlook.')) {
      const target = await call('resolve', { ...input, operation: op })
      const host = new DesktopHost()
      try {
        const { windows } = await host.request<{ windows: { window: string; pid: number; title: string }[] }>('listWindows', {})
        const matches = windows.filter(window => window.pid === target['pid'] && window.title.startsWith(String(target['name'])))
        if (matches.length !== 1) throw new Error('The Office document window could not be identified uniquely.')
        await activity(matches[0]!.window, String(target['name']))
      } finally { host.close() }
      if (typeof target['workbook'] === 'string') input = { ...input, workbook: target['workbook'] }
    }
    let backup: string | undefined
    if (source && content && args['save'] === true) {
      if (await digest(source) !== disk) throw new Error('Document changed before saving.')
      backup = join(dirname(source), `${source.slice(dirname(source).length + 1)}.engram-backup-${randomUUID()}`)
      await copyFile(source, backup, constants.COPYFILE_EXCL)
    }
    const result = await call(op, input)
    if (kind && source && op.endsWith('.read')) {
      if (!Array.isArray(result['content']) || result['content'].some(item => !item || typeof item.key !== 'string' || typeof item.text !== 'string')) throw new Error('Office did not return complete document text.')
      if (await digest(source) !== disk) throw new Error('Document changed during reading. Read again.')
      const revision = randomUUID().replaceAll('-', '')
      if (reads.size >= 32) reads.clear()
      reads.set(revision, { file: source, kind, content: result['content'] as OfficeText[], digest: disk! })
      return { ...result, revision, scope: 'Word main body; PowerPoint ordinary text shapes and speaker notes. Visual layout must be checked separately.' }
    }
    return backup ? { ...result, backup } : result
  } finally {
    if (guard) clearInterval(guard)
    signal?.removeEventListener('abort', abort)
    running.delete(controller)
    await rm(directory, { recursive: true, force: true })
  }
}
