import { resolve } from 'node:path'
import { parseReadBatch } from './browser-read-batch.js'
import type { AgentLoopStep } from './agent-loop.js'

// cwd: the task folder a relative fromPath is read against.
export function outputLinks(steps: AgentLoopStep[], answer: string, cwd = ''): string {
  const selected = new Set([...answer.matchAll(/\]\(engram-artifact:([A-Za-z0-9%_.-]+)\)/g)].map(match => match[1]!))
  const fileName = (id: string) => decodeURIComponent(id).replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i, '')
  const COMPOSED = ['word_write', 'ppt_build']
  // What a receipt was made from, by the rule the host's native delivery uses (deliverOutputs): a copy's fromPath; content (and a content copy's
  // task-folder twin, compared after the same resolve() as fromPath so a Windows drive letter or a relative twin path still matches), one source; any other tool and the file it names, else its own input. The same source made again under one name is a
  // revision, where the last one counts, whether or not the answer links anything: a budget stop or an unfinished turn links nothing, and what
  // is attached here the host cannot take back (qa143 S19a: every copy of one report.md was attached). A receipt naming no source is its own.
  const twins = new Set(steps.flatMap(step => { try { const path = step.tool === 'file_create_copy' && typeof step.args['content'] === 'string' ? (JSON.parse(step.observation) as { taskPath?: unknown }).taskPath : undefined; return typeof path === 'string' ? [resolve(cwd, path)] : [] } catch { return [] } }))
  const sourceOf = (step: AgentLoopStep, link: string): string => {
    if (step.tool === 'file_create_copy') {
      const from = typeof step.args['fromPath'] === 'string' ? resolve(cwd, step.args['fromPath']) : undefined
      return from && !twins.has(from) ? `path\0${from}` : from || typeof step.args['content'] === 'string' ? 'content' : link
    }
    const input = COMPOSED.includes(step.tool) ? undefined : [step.args['source'], step.args['sourcePath'], step.args['path']].find(value => typeof value === 'string') as string | undefined
    return `${step.tool}\0${input ? resolve(cwd, input) : JSON.stringify(step.args)}`
  }
  const outputs: { link: string; id: string; name: string; source: string; composed: boolean }[] = []
  for (const step of steps) {
    if (!['file_create_copy', 'file_create_workbook', 'file_edit_package', 'capture_evidence', ...COMPOSED].includes(step.tool)) continue
    try {
      const result = JSON.parse(step.observation) as { markdownLink?: unknown }
      const match = typeof result.markdownLink === 'string' && result.markdownLink.match(/^\[[^\]\r\n]+\]\(engram-artifact:([A-Za-z0-9%_.-]+)\)$/)
      if (match) outputs.push({ link: result.markdownLink as string, id: match[1]!, name: fileName(match[1]!), source: sourceOf(step, result.markdownLink as string), composed: COMPOSED.includes(step.tool) })
    } catch { /* Failed writes have no output receipt. */ }
  }
  // The answer's link sets aside the other versions of the input it quotes, not another input's file of that name: two different inputs under
  // one name are two files (qa143 S19a). Nothing later hands over a composed document or deck, so another input of a linked name is attached
  // here; a file receipt under a linked name is left to the host, which names a second source apart (report-2.md).
  const chosen = outputs.filter(output => selected.has(output.id))
  const links = new Map<string, string>()
  for (const output of outputs) {
    if (selected.has(output.id) || chosen.some(one => one.name === output.name && (!output.composed || one.source === output.source))) continue
    links.set(`${output.name}\0${output.source}`, output.link)
  }
  return links.size ? `${answer}\n\n${[...new Set(links.values())].join('\n\n')}` : answer
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
  // A read that failed changed nothing, and a result check reported after it is judged by the host readback by readback (which final bytes were
  // read, which were not): that verdict stands instead of this one. qa143 S19: an unreadable PDF's file_read turned a checked wrap-up into
  // "Not verified as complete", continued it automatically and had it restated.
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
  } catch { /* Text observations have no structured failure field. */ }
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
