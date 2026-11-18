import { officeTools, type AgentTool, type OfficeOp } from 'core'
import { officeWorkPreview, showWorkPreview } from './work-preview.js'
import { screen } from 'electron'
import { officeApps, officeRequest, officeSupported } from './office-host.js'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import { bindDesktopForLane } from './desktop-access.js'
import { applicationWork, clearApplicationWork } from './application-work.js'
import { freeName } from './file-work.js'

// A new deck or document is composed as a file with a designed layout, not
// clicked into a blank template; everything else on Office goes through the
// application's own commands. The person keeps the mouse either way.
// Where a composed document is handed in: the workspace's saved outputs and
// the task folder, linked in the chat.
interface OfficeOutputs { save(name: string, data: Buffer): Promise<Record<string, unknown>>; held?(): Promise<Set<string>> }

// Hangul a person writes, KS X 1001's 2,350 syllables; empty where the runtime has no EUC-KR decoder (the check is then skipped).
const COMMON_HANGUL = ((): Set<string> => {
  const found = new Set<string>()
  try { const decode = new TextDecoder('euc-kr'); for (let lead = 0xb0; lead <= 0xc8; lead++) for (let trail = 0xa1; trail <= 0xfe; trail++) found.add(decode.decode(Uint8Array.of(lead, trail))) } catch { /* No decoder: nothing is flagged. */ }
  return found
})()
// grokbar D3 (stack9): the first deck read "수시 입력", "대믱", "변류̈은", the second "결맠". c11c (stack10 "전놙0대름"): text a person never
// types, judged by its characters alone, never a word list: a Hangul syllable outside the common 2,350 (skipped where no decoder exists), a
// combining mark on Hangul, a loose conjoining jamo, a replacement character (U+FFFD) or a control character. Each word is named with where it is.
// c11c r2: a rare syllable is real only where the person typed it themselves (personal: their words in this thread, e.g. a name); the
// model resending its own slip proves nothing, and the other marks are never typed by anyone, so nothing lets them through.
export function mistypedWords(texts: readonly { where: string; text: string }[], personal = ''): string[] {
  const odd = (one: string) => /[\uFFFD\u1100-\u11FF]/.test(one) || (one < ' ' && !'\t\n\r'.includes(one)) || (COMMON_HANGUL.size > 0 && /[가-힣]/.test(one) && !COMMON_HANGUL.has(one) && !personal.includes(one))
  return texts.flatMap(({ where, text }) => (text.match(/[^\s,.:;()[\]"'“”‘’·/|-]+/g) ?? [])
    .filter(word => /[가-힣\u1100-\u11FF][\u0300-\u036f]/.test(word) || [...word].some(odd))
    .map(word => `${word} (${where})`)).slice(0, 8)
}
// c10c r3 (D3): the garbled words of the stack-9 deck were the model's own sampling slips, one UTF-8 byte off (결→거, 말→맠): most land on
// syllables people do type ("거실론", "수시 입력"), so no syllable list can catch them. Before the file is built, the quick voice reads the
// document's text once and names each garbled word with the word meant; the host puts those in and builds once. The syllable check above
// stays the backstop for when the voice is late or absent. A reply is used only where it is safe: the word is in the text, both are
// Korean, no digit changes, and the length stays close, so a proofread can fix a slip but never rewrite content.
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

// A new deck or document is built headlessly and handed in; no Office window
// opens and nothing lands in the person's own folders (QA 0.8.142 B5/B11).
async function composeOffice(op: 'ppt.build' | 'word.write', asked: Record<string, unknown>, outputs: OfficeOutputs | undefined, own: Set<string>, personal: string, signal?: AbortSignal, assertActive?: () => void, proofread?: Proofread): Promise<unknown> {
  signal?.throwIfAborted()
  assertActive?.()
  if (!outputs) throw new Error('A document can be composed only in a chat that keeps its outputs.')
  const said = written(op, asked).texts.map(one => one.text)
  const fixes = proofread && said.some(text => /[가-힣]/.test(text)) ? await proofread(proofPrompt(said)).then(raw => proofFixes(raw, said), () => []) : []
  const args = fixes.length ? withFixes(asked, fixes) as Record<string, unknown> : asked
  // c11c (D3 stack10: a garbled deck was saved, then fixed in three more rounds and forked a second file): broken text is refused before any
  // file exists, with the exact words, so the fix is one rebuild. A rare syllable the person typed (a name) is theirs (mistypedWords).
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
  // grokbar D3 (stack9): a second build under the name this turn already saved got "-2", a third "-3", and all three were shown. The same name
  // in one turn is that turn's own file made again: it keeps the name and replaces it (file-work.ts placeInTask, agent-session-result.ts
  // outputLinks). A file an earlier turn made is not this tool's to rename: placeInTask keeps that one as the earlier version.
  // c10c r1: a name this turn built is its own draft, replaced in place; a name the task folder held before (an earlier turn's file) is
  // never overwritten: this build takes the next free name (deck-2.pptx).
  const held = await outputs.held?.() ?? new Set<string>()
  const name = freeName(built.name, free => held.has(free.normalize('NFC')) && !own.has(free))
  own.add(name.toLowerCase())
  const receipt = await outputs.save(name, built.data)
  const count = 'slides' in built ? { slides: built.slides } : { blocks: built.blocks }
  const { titles } = written(op, args)
  // c15c (D3: a deck built clean was read back with file_read_package and built a third time, 20-25 s of writing each): the receipt says what
  // the host verified in the file - how many slides and their titles - and any words it corrected, so nothing is left to read back.
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

// Office apps go on the comet's menu through their own commands, never
// through the screen: the person keeps the mouse, the app changes in place,
// and a draft mail opens for them to send. Only the applications this
// machine registers are offered.
// ponytail: one visible Office operation at a time; split only for isolated application sessions.
// A document command shows only the window it is working in (QA145 S02: a
// file read attached the chat to the person's own open Word window, which the
// task never touched). window is that window's id; '' means the host cannot
// name one (Windows), so the app is matched by name as before.
export async function showOfficePreview(lane: string, op: OfficeOp, window?: string): Promise<void> {
  const app = op.startsWith('outlook.') ? 'Outlook' : op.startsWith('excel.') ? 'Excel' : op.startsWith('word.') ? 'Word' : 'PowerPoint'
  const wholeApp = op.startsWith('outlook.') || op === 'excel.workbooks'
  if (!wholeApp && window === undefined) return
  try { showWorkPreview(await bindDesktopForLane(lane, { app: window ? `window:${window}:0` : app })) }
  catch { /* The activity card remains available when no readable window exists. */ }
}
let workQueue: Promise<unknown> = Promise.resolve()
// proofread: the quick voice, which reads a new document's text for garbled words before it is built (composeOffice).
// personal: the person's own words in this thread, where a rare syllable in a document is theirs, not a slip (mistypedWords).
export function officeAgentTools(lane: string, outputs?: OfficeOutputs, proofread?: Proofread, personal = ''): AgentTool[] {
  const apps = officeApps()
  if (!officeSupported() || !apps) return []
  // The same deck or document built again in this session is the file already
  // handed in, not a twin: built bytes carry a timestamp (QA 0.8.142 B11 duplicates).
  const composed = new Map<string, unknown>()
  // The names this tool set's builds saved (one turn's: ipc.ts makes the set per turn), which a later build here may replace.
  const own = new Set<string>()
  const tools = officeTools({ run: async (op, args, signal) => {
    if (op === 'ppt.build' || op === 'word.write') {
      const key = `${op}\0${JSON.stringify(args)}`
      if (composed.has(key)) { signal?.throwIfAborted(); assertDesktopTurnNotStopped(lane); return composed.get(key) }
      const receipt = await composeOffice(op, args, outputs, own, personal, signal, () => assertDesktopTurnNotStopped(lane), proofread)
      // Another build under this name replaced the file an earlier receipt names: that receipt is no longer the file to hand back.
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
  // The principle, not a recipe: an application that answers to commands is
  // driven by its command tool, which changes the open document in place and
  // leaves the person their mouse. Reading and clicking the screen is the
  // last resort, for an application that offers no such tool. Which command
  // tools exist this run is what the menu already shows.
  return 'Prefer available application command tools over screen input. Briefly explain transitions between work surfaces before acting, not every click; never simulate visible work or claim a window is open before confirming it. Excel commands edit the explicitly named workbook and sheet; mail commands only create drafts. A mail draft does not need a recipient. When the person gives no address, choose one path before your first message and keep to it: prefer calling outlook_draft without to, so the draft opens for them to add one, or ask for the address once. Never say a recipient is required, and never ask for an address after saying you will draft without one. On either path, put the full mail text you wrote in your reply. word_write and ppt_build generate NEW files. For existing files use word_read/ppt_read then word_edit/ppt_edit with the returned revision; edits stay unsaved unless saving is requested. If word_edit cannot change an existing document, do not create a replacement with word_write on your own: say that editing in place failed and ask whether to save the changes as a separate copy. Only after the person agrees, call word_write with saveAs set to a bare file name that clearly differs from the original, such as the original name followed by " (edited)"; never reuse or overwrite the original path. These text tools do not cover every object or visual layout. Verify results with the application before claiming completion. After interruption, inspect partial changes instead of replaying writes.'
}
