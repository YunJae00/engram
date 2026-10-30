import type { AgentLoopStep } from './agent-loop.js'

export function outputLinks(steps: AgentLoopStep[], answer: string): string {
  const selected = new Set([...answer.matchAll(/\]\(engram-artifact:([A-Za-z0-9%_.-]+)\)/g)].map(match => match[1]!))
  const fileName = (id: string) => decodeURIComponent(id).replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i, '')
  const outputs: { link: string; id: string; name: string }[] = []
  const links = new Set<string>()
  for (const step of steps) {
    if (!['file_create_copy', 'file_create_workbook', 'file_edit_package', 'capture_evidence'].includes(step.tool)) continue
    try {
      const result = JSON.parse(step.observation) as { markdownLink?: unknown }
      const match = typeof result.markdownLink === 'string' && result.markdownLink.match(/^\[[^\]\r\n]+\]\(engram-artifact:([A-Za-z0-9%_.-]+)\)$/)
      if (match) outputs.push({ link: result.markdownLink as string, id: match[1]!, name: fileName(match[1]!) })
    } catch { /* Failed writes have no output receipt. */ }
  }
  const chosenNames = new Set(outputs.filter(output => selected.has(output.id)).map(output => output.name))
  for (const output of outputs) if (!selected.has(output.id) && !chosenNames.has(output.name)) links.add(output.link)
  return links.size ? `${answer}\n\n${[...links].join('\n\n')}` : answer
}

export function finalDesktopFailure(steps: AgentLoopStep[]): string | undefined {
  const browser = steps.filter(step => ['read_pages', 'read_open_page', 'open_page', 'verify'].includes(step.tool)).at(-1)
  if (browser?.tool === 'read_pages' && browser.observation.startsWith('that did not work:')) return 'The last batch stopped before all pages were read. Inspect the current state and continue only unfinished reads.'
  const step = steps.filter((one) => one.tool.startsWith('file_') || ['app_read', 'app_text', 'app_set', 'app_press', 'app_do', 'desktop_action', 'desktop_sequence', 'read_desktop', 'look_desktop', 'read_live_document', 'edit_live_document', 'compose_live_document'].includes(one.tool)).at(-1)
  if (!step) return undefined
  const incomplete = 'The last computer or file result failed or may be stale and has not been verified.'
  if (step.observation.startsWith('that did not work:')) return incomplete
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
