import { officeTools, type AgentTool, type OfficeOp } from 'core'
import { officeWorkPreview, showWorkPreview } from './work-preview.js'
import { screen } from 'electron'
import { officeApps, officeRequest, officeSupported } from './office-host.js'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import { bindDesktopForLane } from './desktop-access.js'
import { applicationWork, clearApplicationWork } from './application-work.js'

// A new deck or document is composed as a file with a designed layout, not
// clicked into a blank template; everything else on Office goes through the
// application's own commands. The person keeps the mouse either way.
async function officeRun(op: OfficeOp, args: Record<string, unknown>, signal?: AbortSignal, assertActive?: () => void, activity?: (window: string, name: string) => Promise<void>): Promise<unknown> {
  assertActive?.()
  const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = Math.min(1100, work.width * 0.82), height = Math.min(800, work.height * 0.82)
  const compact = { x: (work.x + (work.width - width) / 2) * 0.75, y: (work.y + (work.height - height) / 2) * 0.75, width: width * 0.75, height: height * 0.75 }
  if (op === 'ppt.build') {
    signal?.throwIfAborted()
    const { renderDeck } = await import('./deck-render.js')
    const result = await renderDeck(args as unknown as Parameters<typeof renderDeck>[0], false, signal, assertActive)
    await officeRequest('ppt.read', { file: result.path, compact }, signal, assertActive, activity)
    return { presentation: result.path, slides: result.slides, saved: result.path, verification: 'File generated; visual rendering is not verified. Inspect every slide before claiming completion.' }
  }
  if (op === 'word.write') {
    signal?.throwIfAborted()
    const { renderDoc } = await import('./doc-render.js')
    const result = await renderDoc(args as unknown as Parameters<typeof renderDoc>[0], false, signal, assertActive)
    await officeRequest('word.read', { file: result.path, compact }, signal, assertActive, activity)
    return { document: result.path, blocks: result.blocks, saved: result.path, verification: 'File generated; application rendering is not verified.' }
  }
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
export function officeAgentTools(lane: string): AgentTool[] {
  const apps = officeApps()
  if (!officeSupported() || !apps) return []
  const tools = officeTools({ run: (op, args, signal) => {
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
  return 'Prefer available application command tools over screen input. Briefly explain transitions between work surfaces before acting, not every click; never simulate visible work or claim a window is open before confirming it. Excel commands edit the explicitly named workbook and sheet; mail commands only create drafts. word_write and ppt_build generate NEW files. For existing files use word_read/ppt_read then word_edit/ppt_edit with the returned revision; edits stay unsaved unless saving is requested. If word_edit cannot change an existing document, do not create a replacement with word_write on your own: say that editing in place failed and ask whether to save the changes as a separate copy. Only after the person agrees, call word_write with saveAs set to a bare file name that clearly differs from the original, such as the original name followed by " (edited)"; never reuse or overwrite the original path. These text tools do not cover every object or visual layout. Verify results with the application before claiming completion. After interruption, inspect partial changes instead of replaying writes.'
}
