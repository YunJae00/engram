import { officeTools, type AgentTool, type OfficeOp } from 'core'
import { officeWorkPreview, showWorkPreview } from './work-preview.js'
import { screen } from 'electron'
import { officeApps, officeRequest, officeSupported } from './office-host.js'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import { bindDesktopForLane } from './desktop-access.js'
import { applicationWork, clearApplicationWork } from './application-work.js'
import { freeName } from './file-work.js'

interface OfficeOutputs { save(name: string, data: Buffer): Promise<Record<string, unknown>>; held?(): Promise<Set<string>> }

const COMMON_HANGUL = ((): Set<string> => {
  const found = new Set<string>()
  try { const decode = new TextDecoder('euc-kr'); for (let lead = 0xb0; lead <= 0xc8; lead++) for (let trail = 0xa1; trail <= 0xfe; trail++) found.add(decode.decode(Uint8Array.of(lead, trail))) } catch {}
  return found
})()
export function mistypedWords(texts: readonly { where: string; text: string }[], personal = ''): string[] {
  const odd = (one: string) => /[\uFFFD\u1100-\u11FF]/.test(one) || (one < ' ' && !'\t\n\r'.includes(one)) || (COMMON_HANGUL.size > 0 && /[가-힣]/.test(one) && !COMMON_HANGUL.has(one) && !personal.includes(one))
  return texts.flatMap(({ where, text }) => (text.match(/[^\s,.:;()[\]"'“”‘’·/|-]+/g) ?? [])
    .filter(word => /[가-힣\u1100-\u11FF][\u0300-\u036f]/.test(word) || [...word].some(odd))
    .map(word => `${word} (${where})`)).slice(0, 8)
}
type Proofread = (prompt: string) => Promise<string>
export const PROOF_MS = 5000
const proofPrompt = (texts: readonly string[]): string => [
  'Below are lines of a Korean document, one per line. Some words may have been garbled while typing: a wrong or stray syllable, a stray mark, a word nobody writes or that does not fit its sentence.',
  'For each garbled word write one line: garbled => intended. Change nothing else: not the style, spacing, numbers, names, English or anything correct.',
  'If nothing is garbled, reply with exactly NONE.',
  '',
  ...texts,
].join('\n')
export function proofFixes(raw: string, texts: readonly string[]): [string, string][] {
  const whole = texts.join('\n'), digits = (text: string): string => text.replace(/\D/g, '')
  const fixes = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const found = /^\s*(?:[-*•]\s+|\d+[.)]\s+)?["'“‘]?(.+?)["'”’]?\s*(?:=>|->|→)\s*["'“‘]?(.+?)["'”’]?\s*$/.exec(line)
    if (!found) continue
    const [, wrong = '', right = ''] = found
    if (wrong === right || !whole.includes(wrong) || !/[가-힣]/.test(wrong) || !/[가-힣]/.test(right) || digits(wrong) !== digits(right) || Math.abs([...wrong].length - [...right].length) > 2) continue
    fixes.set(wrong, right)
  }
  return [...fixes]
}
const withFixes = (value: unknown, fixes: readonly [string, string][]): unknown =>
  typeof value === 'string' ? fixes.reduce((text, [wrong, right]) => text.split(wrong).join(right), value)
    : Array.isArray(value) ? value.map(one => withFixes(one, fixes))
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, one]) => [key, withFixes(one, fixes)])) : value
const written = (op: 'ppt.build' | 'word.write', args: Record<string, unknown>): { titles: string[]; texts: { where: string; text: string }[] } => {
  if (op === 'ppt.build') {
    const slides = (Array.isArray(args['slides']) ? args['slides'] : []) as { title?: unknown; subtitle?: unknown; bullets?: unknown; table?: { rows?: unknown } }[]
    return {
      titles: slides.map(slide => String(slide.title ?? '')),
      texts: slides.flatMap((slide, at) => [slide.title, slide.subtitle, ...(Array.isArray(slide.bullets) ? slide.bullets : []), ...(Array.isArray(slide.table?.rows) ? (slide.table.rows as unknown[]).flat() : [])]
        .filter((one): one is string => typeof one === 'string').map(text => ({ where: `slide ${at + 1}`, text }))),
    }
  }
  const blocks = (Array.isArray(args['blocks']) ? args['blocks'] : []) as { kind?: unknown; text?: unknown; items?: unknown; table?: { rows?: unknown } }[]
  return {
    titles: blocks.filter(block => ['title', 'heading'].includes(String(block.kind)) && typeof block.text === 'string').map(block => block.text as string),
    texts: blocks.flatMap((block, at) => [block.text, ...(Array.isArray(block.items) ? block.items : []), ...(Array.isArray(block.table?.rows) ? (block.table.rows as unknown[]).flat() : [])]
      .filter((one): one is string => typeof one === 'string').map(text => ({ where: `block ${at + 1}`, text }))),
  }
}

async function composeOffice(op: 'ppt.build' | 'word.write', asked: Record<string, unknown>, outputs: OfficeOutputs | undefined, own: Set<string>, personal: string, signal?: AbortSignal, assertActive?: () => void, proofread?: Proofread): Promise<unknown> {
  signal?.throwIfAborted()
  assertActive?.()
  if (!outputs) throw new Error('A document can be composed only in a chat that keeps its outputs.')
  const said = written(op, asked).texts.map(one => one.text)
  const fixes = proofread && said.some(text => /[가-힣]/.test(text)) ? await proofread(proofPrompt(said)).then(raw => proofFixes(raw, said), () => []) : []
  const args = fixes.length ? withFixes(asked, fixes) as Record<string, unknown> : asked
  const odd = mistypedWords(written(op, args).texts, personal)
  if (odd.length) {
    throw new Error(`Nothing was built: these words are garbled (a character nobody types): ${odd.join(', ')}. Write each as the word meant and call ${op === 'ppt.build' ? 'ppt_build' : 'word_write'} again with everything else the same.`)
  }
  signal?.throwIfAborted()
  assertActive?.()
  const built = op === 'ppt.build'
    ? await (await import('./deck-render.js')).buildDeck(args as unknown as Parameters<typeof import('./deck-render.js').buildDeck>[0])
    : await (await import('./doc-render.js')).buildDoc(args as unknown as Parameters<typeof import('./doc-render.js').buildDoc>[0])
  signal?.throwIfAborted()
  assertActive?.()
  const held = await outputs.held?.() ?? new Set<string>()
  const name = freeName(built.name, free => held.has(free.normalize('NFC')) && !own.has(free))
  own.add(name.toLowerCase())
  const receipt = await outputs.save(name, built.data)
  const count = 'slides' in built ? { slides: built.slides } : { blocks: built.blocks }
  const { titles } = written(op, args)
  const listed = titles.length ? ` ${op === 'ppt.build' ? 'Slides' : 'Headings'}: ${titles.map((title, at) => `${at + 1}. ${title}`).join(' / ')}.` : ''
  const counted = 'slides' in built ? `${built.slides} slides` : `${built.blocks} blocks`
  const corrected = fixes.length ? ` The host corrected these words in the file: ${fixes.map(([wrong, right]) => `${wrong} → ${right}`).join(', ')}.` : ''
  return {
    ...receipt, ...count, ...(titles.length ? { titles } : {}),
    verification: `Saved as ${name} and compared byte for byte by the host; no Office window was opened. Verified in the file: ${counted}, every one with the text you gave${fixes.length ? ' but for the words below' : ''}.${listed}${corrected} It is done: do not read it back or build it again. Answer now with its markdownLink.`,
  }
}

async function officeRun(op: OfficeOp, args: Record<string, unknown>, signal?: AbortSignal, assertActive?: () => void, activity?: (window: string, name: string) => Promise<void>): Promise<unknown> {
  assertActive?.()
  const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(1100, work.width * 0.82), height = Math.min(800, work.height * 0.82)
  const compact = { x: (work.x + (work.width - width) / 2) * 0.75, y: (work.y + (work.height - height) / 2) * 0.75, width: width * 0.75, height: height * 0.75 }
  return officeRequest(op, { ...args, compact }, signal, assertActive, activity)
}

export async function showOfficePreview(lane: string, op: OfficeOp, window?: string): Promise<void> {
  const app = op.startsWith('outlook.') ? 'Outlook' : op.startsWith('excel.') ? 'Excel' : op.startsWith('word.') ? 'Word' : 'PowerPoint'
  const wholeApp = op.startsWith('outlook.') || op === 'excel.workbooks'
  if (!wholeApp && window === undefined) return
  try { showWorkPreview(await bindDesktopForLane(lane, { app: window ? `window:${window}:0` : app })) }
  catch {}
}
let workQueue: Promise<unknown> = Promise.resolve()
export function officeAgentTools(lane: string, outputs?: OfficeOutputs, proofread?: Proofread, personal = ''): AgentTool[] {
  const apps = officeApps()
  if (!officeSupported() || !apps) return []
  const composed = new Map<string, unknown>()
  const own = new Set<string>()
  const tools = officeTools({ run: async (op, args, signal) => {
    if (op === 'ppt.build' || op === 'word.write') {
      const key = `${op}\0${JSON.stringify(args)}`
      if (composed.has(key)) { signal?.throwIfAborted(); assertDesktopTurnNotStopped(lane); return composed.get(key) }
      const receipt = await composeOffice(op, args, outputs, own, personal, signal, () => assertDesktopTurnNotStopped(lane), proofread)
      const named = (one: unknown): string | undefined => /^\[([^\]]+)\]/.exec(String((one as { markdownLink?: unknown }).markdownLink ?? ''))?.[1]?.toLowerCase()
      for (const [held, earlier] of composed) if (named(earlier) === named(receipt)) composed.delete(held)
      composed.set(key, receipt)
      return receipt
    }
    const run = async () => {
      signal?.throwIfAborted()
      assertDesktopTurnNotStopped(lane)
      const finish = officeWorkPreview(lane, op)
      try {
        const wholeApp = op.startsWith('outlook.') || op === 'excel.workbooks'
        if (wholeApp || process.platform === 'win32') await showOfficePreview(lane, op, wholeApp ? undefined : '')
        signal?.throwIfAborted()
        assertDesktopTurnNotStopped(lane)
        if (wholeApp) {
          clearApplicationWork(lane)
          return await officeRun(op, args, signal, () => assertDesktopTurnNotStopped(lane))
        }
        const work = applicationWork(lane, signal)
        try { return await officeRun(op, args, work.signal, () => assertDesktopTurnNotStopped(lane), process.platform === 'win32' ? undefined : async (window, name) => { await work.show(window, name); await showOfficePreview(lane, op, window) }) }
        catch (error) { clearApplicationWork(lane); throw error }
      } finally { finish() }
    }
    const next = workQueue.then(run, run)
    workQueue = next.catch(() => undefined)
    return next
  } })
  return tools.filter((tool) => {
    if (tool.name.startsWith('excel_')) return apps.excel
    if (tool.name.startsWith('outlook_')) return apps.outlook
    if (tool.name.startsWith('word_')) return apps.word
    if (tool.name.startsWith('ppt_')) return apps.powerpoint
    return false
  })
}

export function officeContext(): string {
  const apps = officeApps()
  if (!officeSupported() || !apps) return ''
  return 'Prefer available application command tools over screen input. Briefly explain transitions between work surfaces before acting, not every click; never simulate visible work or claim a window is open before confirming it. Excel commands edit the explicitly named workbook and sheet; mail commands only create drafts. A mail draft does not need a recipient. When the person gives no address, choose one path before your first message and keep to it: prefer calling outlook_draft without to, so the draft opens for them to add one, or ask for the address once. Never say a recipient is required, and never ask for an address after saying you will draft without one. On either path, put the full mail text you wrote in your reply. word_write and ppt_build generate NEW files. For existing files use word_read/ppt_read then word_edit/ppt_edit with the returned revision; edits stay unsaved unless saving is requested. If word_edit cannot change an existing document, do not create a replacement with word_write on your own: say that editing in place failed and ask whether to save the changes as a separate copy. Only after the person agrees, call word_write with saveAs set to a bare file name that clearly differs from the original, such as the original name followed by " (edited)"; never reuse or overwrite the original path. These text tools do not cover every object or visual layout. Verify results with the application before claiming completion. After interruption, inspect partial changes instead of replaying writes.'
}
