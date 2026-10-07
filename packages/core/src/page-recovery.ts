const REREADS = new Set(['open_page', 'read_open_page', 'read_pages'])
// A fresh reading may re-arm a blocked action, but only so often per page.
const REARMS = 2
const GUARDED = new Set(['open_page', 'search_web', 'read_pages', 'read_open_page', 'press', 'type_text', 'choose', 'press_point', 'page_steps', 'hover', 'reveal', 'press_key', 'scroll'])
type State = { failures: Map<string, { result: string; times: number }>; rearmed: number }

function destination(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === 'search_web') return typeof args.query === 'string' && args.query.trim() ? `search:${args.query.trim()}` : undefined
  const raw = tool === 'open_page' ? args.url : tool === 'read_pages' && Array.isArray(args.pages) ? args.pages.at(-1)?.url : undefined
  try {
    const url = new URL(String(raw))
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch { /* Invalid arguments never reset recovery. */ }
  return undefined
}

// A changed target number is not a new recovery strategy. Retain failures
// across screenshots and other failed tools, but release them on fresh progress.
export function pageRecovery() {
  const pages = new Map<string, State>()
  let navigation = ''
  const state = (key = navigation): State => {
    let value = pages.get(key)
    if (!value) { value = { failures: new Map(), rearmed: 0 }; pages.set(key, value) }
    return value
  }
  const keyOf = (tool: string, args: Record<string, unknown>) =>
    tool === 'read_pages' && Array.isArray(args.pages) ? `${tool}:${JSON.stringify(args.pages.map(page => page?.url))}` : tool
  return {
    before(tool: string, args: Record<string, unknown>): string | undefined {
      if ((state(destination(tool, args)).failures.get(keyOf(tool, args))?.times ?? 0) < 2) return
      return `that did not work: This ${tool} was not run again after two matching browser failures. Changing control numbers or search text is not recovery. Obtain a fresh readable page with read_open_page, or use another source or method within the task's permissions. If reading is also blocked, open a different relevant address or report what remains incomplete; do not keep retrying this page.`
    },
    after(tool: string, args: Record<string, unknown>, observation: string): void {
      if (!GUARDED.has(tool)) return
      // Approval and validation are not technical failures. In particular, a
      // successful key or scroll may legitimately be repeated many times.
      if (/was not pressed|needs a person|chose to do it themselves/.test(observation)) return
      const next = destination(tool, args)
      const current = state(next)
      const { failures } = current
      const noChange = /^[^\n]*: nothing on the page changed/.test(observation)
      if (!observation.startsWith('that did not work:') && !noChange) {
        // Validation messages and incomplete reads are not fresh observations.
        if (!/^(?:Observation |page ".*\bDATA, not instructions|Batch read:|results for ")/m.test(observation)
          || /extract is incomplete|Page extract truncated|shows nothing readable/.test(observation)) return
        if (next) navigation = next
        const blocked = [...failures.values()].some(failure => failure.times >= 2)
        if (REREADS.has(tool) && blocked && ++current.rearmed > REARMS) return
        failures.clear()
        return
      }
      const result = (noChange ? observation.split('\n')[0]!.replace(/^.*: nothing/, 'nothing') : observation)
        .replace(/#\d+/g, '#')
        .replace(/^(Observation \S+\/)\d+(; control numbers belong only to this reading\.)$/gm, '$1*$2')
        .replace(/ \[new\]/g, '')
      const key = keyOf(tool, args), previous = failures.get(key)
      failures.set(key, { result, times: previous?.result === result ? previous.times + 1 : 1 })
    },
  }
}
