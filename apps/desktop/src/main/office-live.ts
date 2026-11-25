import { officeTools, type AgentTool, type OfficeOp } from 'core'
import { officeWorkPreview, showWorkPreview } from './work-preview.js'
import { screen } from 'electron'
import { officeApps, officeRequest, officeSupported } from './office-host.js'
import { assertDesktopTurnNotStopped } from './desktop-control.js'
import { bindDesktopForLane } from './desktop-access.js'
import { applicationWork, clearApplicationWork } from './application-work.js'

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
export function officeAgentTools(lane: string, builds: AgentTool[]): AgentTool[] {
  const apps = officeApps()
  if (!officeSupported() || !apps) return []
  const tools = officeTools({ run: async (op, args, signal) => {
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
  return tools.flatMap(tool => tool.name === 'word_write' || tool.name === 'ppt_build' ? builds.filter(build => build.name === tool.name) : [tool]).filter((tool) => {
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
