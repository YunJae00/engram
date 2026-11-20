import { basename, resolve } from 'node:path'
import { parseReadBatch } from './browser-read-batch.js'
import type { AgentLoopStep, FileCard } from './agent-loop.js'

export function outputCards(steps: AgentLoopStep[], answer: string, cwd = ''): FileCard[] {
  const fileName = (id: string) => decodeURIComponent(id).replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i, '')
  const COMPOSED = ['word_write', 'ppt_build']
  const twins = new Set(steps.flatMap(step => { try { const path = step.tool === 'file_create_copy' && typeof step.args['content'] === 'string' ? (JSON.parse(step.observation) as { taskPath?: unknown }).taskPath : undefined; return typeof path === 'string' ? [resolve(cwd, path)] : [] } catch { return [] } }))
  const sourceOf = (step: AgentLoopStep, link: string): string => {
    if (step.tool === 'file_create_copy') {
      const from = typeof step.args['fromPath'] === 'string' ? resolve(cwd, step.args['fromPath']) : undefined
      return from && !twins.has(from) ? `path\0${from}` : from || typeof step.args['content'] === 'string' ? 'content' : link
    }
    const input = COMPOSED.includes(step.tool) ? undefined : [step.args['source'], step.args['sourcePath'], step.args['path']].find(value => typeof value === 'string') as string | undefined
    return `${step.tool}\0${input ? resolve(cwd, input) : JSON.stringify(step.args)}`
  }
  const fresh = (step: AgentLoopStep): boolean => COMPOSED.includes(step.tool) || (step.tool === 'file_create_workbook' && ![step.args['source'], step.args['sourcePath'], step.args['path']].some(value => typeof value === 'string'))
  const edits = (step: AgentLoopStep): string | undefined => step.tool === 'file_edit_package' && typeof step.args['sourcePath'] === 'string' ? fileName(basename(step.args['sourcePath'])).toLowerCase() : undefined
  const outputs: { link: string; id: string; name: string; source: string; composed: boolean; fresh: boolean; edits?: string | undefined; taskPath?: string | undefined }[] = []
  for (const step of steps) {
    if (!['file_create_copy', 'file_create_workbook', 'file_edit_package', 'capture_evidence', ...COMPOSED].includes(step.tool)) continue
    try {
      const result = JSON.parse(step.observation) as { markdownLink?: unknown; taskPath?: unknown }
      const match = typeof result.markdownLink === 'string' && result.markdownLink.match(/^\[[^\]\r\n]+\]\(engram-artifact:([A-Za-z0-9%_.-]+)\)$/)
      if (match) outputs.push({ link: result.markdownLink as string, id: match[1]!, name: fileName(match[1]!), source: sourceOf(step, result.markdownLink as string), composed: COMPOSED.includes(step.tool), fresh: fresh(step), edits: edits(step), taskPath: typeof result.taskPath === 'string' ? result.taskPath : undefined })
    } catch {}
  }
  const last = new Map(outputs.filter(output => output.fresh).map(output => [output.name.toLowerCase(), output]))
  const replaced = new Map(outputs.filter(output => output.fresh && last.get(output.name.toLowerCase())!.id !== output.id).map(output => [output.id, last.get(output.name.toLowerCase())!]))
  const onto = (edit: typeof outputs[number], output: typeof outputs[number]) => edit.taskPath && output.taskPath ? edit.taskPath === output.taskPath : edit.name.toLowerCase() === output.name.toLowerCase()
  outputs.forEach((output, at) => { const edit = outputs.slice(at + 1).filter(one => one.edits === output.name.toLowerCase() && onto(one, output)).at(-1); if (edit && (output.fresh || output.edits)) replaced.set(output.id, edit) })
  const kept = outputs.filter(output => !replaced.has(output.id))
  const selected = new Set([...answer.matchAll(/\]\(engram-artifact:([A-Za-z0-9%_.-]+)\)/g)].map(match => match[1]!))
  const chosen = kept.filter(output => selected.has(output.id))
  const cards = new Map<string, FileCard>()
  for (const output of kept) {
    if (selected.has(output.id) || chosen.some(one => one.name === output.name && (!output.composed || one.source === output.source))) continue
    cards.set(`${output.name}\0${output.source}`, { name: output.link.slice(1, output.link.indexOf('](engram-artifact:')), href: output.id })
  }
  return [...new Map([...cards.values()].map(card => [card.href, card])).values()]
}

const reportedCheck = (step: AgentLoopStep): boolean => {
  if (step.tool !== 'report_result_check') return false
  try { const receipt = JSON.parse(step.observation) as { error?: unknown; resultCheck?: unknown }; return !receipt.error && !!receipt.resultCheck } catch { return false }
}

export function finalDesktopFailure(steps: AgentLoopStep[]): string | undefined {
  const browser = steps.filter(step => ['read_pages', 'read_open_page', 'open_page', 'verify'].includes(step.tool)).at(-1)
  if (browser?.tool === 'read_pages') {
    const batch = parseReadBatch(browser.observation)
    const failed = browser.observation.startsWith('that did not work:') || !!batch && batch.pages.length < batch.requested
    if (failed) return 'The last batch stopped before all pages were read. Inspect the current state and continue only unfinished reads.'
  }
  const step = steps.filter((one) => one.tool.startsWith('file_') || ['app_read', 'app_text', 'app_set', 'app_press', 'app_do', 'desktop_action', 'desktop_sequence', 'read_desktop', 'look_desktop', 'read_live_document', 'edit_live_document', 'compose_live_document'].includes(one.tool)).at(-1)
  if (!step) return undefined
  const incomplete = 'The last computer or file result failed or may be stale and has not been verified.'
  if (step.tool.startsWith('file_read') && steps.slice(steps.lastIndexOf(step) + 1).some(reportedCheck)) return undefined
  if (step.observation.startsWith('that did not work:')) return incomplete
  try {
    const error = JSON.parse(step.observation)?.error
    if (['app_read', 'app_text', 'read_desktop', 'look_desktop', 'read_live_document'].includes(step.tool) && ['accessibility_denied', 'screen_recording_denied'].includes(error)
      && steps.some(one => {
        if (one.tool !== 'open_app') return false
        try { return JSON.parse(one.observation)?.opened === true } catch { return false }
      })) return undefined
    if (error) return incomplete
  } catch {}
  if (step.tool === 'app_set' || step.tool === 'app_text' || step.tool === 'app_do') {
    try {
      const result = JSON.parse(step.observation) as { landed?: boolean; exact?: boolean; settled?: boolean; status?: string }
      if (result.landed === false || result.exact === false || result.settled === false || step.tool === 'app_do' && result.status !== 'done') return incomplete
    } catch { return incomplete }
  }
  if (!['app_set', 'app_press', 'desktop_action', 'desktop_sequence', 'read_live_document', 'edit_live_document', 'compose_live_document'].includes(step.tool)) return undefined
  try {
    const result = JSON.parse(step.observation) as { error?: unknown; observationMayBeStale?: unknown; reobserveRequired?: unknown; completeReadback?: unknown }
    if (result.error || result.observationMayBeStale === true || result.reobserveRequired === true || (step.tool === 'edit_live_document' && result.completeReadback !== true)) return incomplete
  } catch { return undefined }
  return undefined
}
