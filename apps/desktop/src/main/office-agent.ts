import { officeTools, type AgentTool, type OfficeOp } from 'core'
import { renderDeck } from './deck-render.js'
import { renderDoc } from './doc-render.js'
import { officeApps, officeRequest, officeSupported } from './office-host.js'
import { assertDesktopTurnNotStopped } from './desktop-control.js'

// A new deck or document is composed as a file with a designed layout, not
// clicked into a blank template; everything else on Office goes through the
// application's own commands. The person keeps the mouse either way.
function officeRun(op: OfficeOp, args: Record<string, unknown>, signal?: AbortSignal, assertActive?: () => void): Promise<unknown> {
  assertActive?.()
  if (op === 'ppt.build') {
    signal?.throwIfAborted()
    return renderDeck(args as unknown as Parameters<typeof renderDeck>[0], true, signal, assertActive).then((result) => ({ presentation: result.path, slides: result.slides, saved: result.path, verification: 'File generated; visual rendering is not verified. Inspect every slide before claiming completion.' }))
  }
  if (op === 'word.write') {
    signal?.throwIfAborted()
    return renderDoc(args as unknown as Parameters<typeof renderDoc>[0], true, signal, assertActive).then((result) => ({ document: result.path, blocks: result.blocks, saved: result.path, verification: 'File generated; application rendering is not verified.' }))
  }
  return officeRequest(op, args, signal, assertActive)
}

// Office apps go on the comet's menu through their own commands, never
// through the screen: the person keeps the mouse, the app changes in place,
// and a draft mail opens for them to send. Only the applications this
// machine registers are offered.
export function officeAgentTools(lane: string): AgentTool[] {
  const apps = officeApps()
  if (!officeSupported() || !apps) return []
  const tools = officeTools({ run: (op, args, signal) => officeRun(op, args, signal, () => assertDesktopTurnNotStopped(lane)) })
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
  return 'Prefer available application command tools over screen input. Excel commands edit the explicitly named workbook and sheet; mail commands only create drafts. word_write and ppt_build generate NEW files, not edits to an open document. Verify results with the application before claiming completion. After interruption, inspect partial changes instead of replaying writes.'
}
