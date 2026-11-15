import { officeTools, type AgentTool, type OfficeOp } from 'core'
import { officeWorkPreview, showWorkPreview } from './work-preview.js'
import { screen } from 'electron'
import { officeApps, officeRequest, officeSupported } from './office-host.js'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import { bindDesktopForLane } from './desktop-access.js'
import { freeName } from './file-work.js'
import { applicationWork, clearApplicationWork } from './application-work.js'

// A new deck or document is composed as a file with a designed layout, not
// clicked into a blank template; everything else on Office goes through the
// application's own commands. The person keeps the mouse either way.
// Where a composed document is handed in: the workspace's saved outputs and
// the task folder, linked in the chat.
export interface OfficeOutputs { save(name: string, data: Buffer): Promise<Record<string, unknown>> }

// A new deck or document is built headlessly and handed in; no Office window
// opens and nothing lands in the person's own folders (QA 0.8.142 B5/B11).
async function composeOffice(op: 'ppt.build' | 'word.write', args: Record<string, unknown>, outputs: OfficeOutputs | undefined, names: Set<string>, signal?: AbortSignal, assertActive?: () => void): Promise<unknown> {
  signal?.throwIfAborted()
  assertActive?.()
  if (!outputs) throw new Error('A document can be composed only in a chat that keeps its outputs.')
  const built = op === 'ppt.build'
    ? await (await import('./deck-render.js')).buildDeck(args as unknown as Parameters<typeof import('./deck-render.js').buildDeck>[0])
    : await (await import('./doc-render.js')).buildDoc(args as unknown as Parameters<typeof import('./doc-render.js').buildDoc>[0])
  signal?.throwIfAborted()
  assertActive?.()
  // Another input built under a name this session already handed in is another file, known by name: report.docx, report-2.docx (qa143 S19a).
  const name = freeName(built.name, held => names.has(held))
  const receipt = await outputs.save(name, built.data)
  names.add(name.toLowerCase())
  const count = 'slides' in built ? { slides: built.slides } : { blocks: built.blocks }
  return { ...receipt, ...count, verification: 'Built as a file and handed in to the chat; no Office window was opened. Read the saved file back before claiming completion.' }
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
export async function showOfficePreview(lane: string, op: OfficeOp): Promise<void> {
  const app = op.startsWith('outlook.') ? 'Outlook' : op.startsWith('excel.') ? 'Excel' : op.startsWith('word.') ? 'Word' : 'PowerPoint'
  try { showWorkPreview(await bindDesktopForLane(lane, { app })) }
  catch { /* The activity card remains available when no readable window exists. */ }
}
let workQueue: Promise<unknown> = Promise.resolve()
export function officeAgentTools(lane: string, outputs?: OfficeOutputs): AgentTool[] {
  const apps = officeApps()
  if (!officeSupported() || !apps) return []
  // The same deck or document built again in this session is the file already
  // handed in, not a twin: built bytes carry a timestamp (QA 0.8.142 B11 duplicates).
  const composed = new Map<string, unknown>()
  const names = new Set<string>()
  const tools = officeTools({ run: async (op, args, signal) => {
    if (op === 'ppt.build' || op === 'word.write') {
      const key = `${op}\0${JSON.stringify(args)}`
      if (composed.has(key)) { signal?.throwIfAborted(); assertDesktopTurnNotStopped(lane); return composed.get(key) }
      const receipt = await composeOffice(op, args, outputs, names, signal, () => assertDesktopTurnNotStopped(lane))
      composed.set(key, receipt)
      return receipt
    }
    const run = async () => {
      signal?.throwIfAborted()
      assertDesktopTurnNotStopped(lane)
      const finish = officeWorkPreview(lane, op)
      try {
        await showOfficePreview(lane, op)
        signal?.throwIfAborted()
        assertDesktopTurnNotStopped(lane)
        if (op.startsWith('outlook.') || op === 'excel.workbooks') {
          clearApplicationWork(lane)
          return await officeRun(op, args, signal, () => assertDesktopTurnNotStopped(lane))
        }
        const work = applicationWork(lane, signal)
        try { return await officeRun(op, args, work.signal, () => assertDesktopTurnNotStopped(lane), process.platform === 'win32' ? undefined : work.show) }
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
