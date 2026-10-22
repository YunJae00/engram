import type { AgentTool } from './agent-loop.js'
import type { PageMove, WebCourier } from './errand.js'
import { str } from './page-report.js'

// One move on the open page, as page_steps and page_each both make it.
export function makeMove(courier: WebCourier, step: Record<string, unknown>, signal?: AbortSignal): Promise<PageMove> | PageMove {
  const target = str(step, 'target'), kind = str(step, 'do')
  const { press, typeText, choose, pressKey } = courier
  if (kind === 'type' && target && typeof step['text'] === 'string' && step['text'] && typeText) return typeText(target, step['text'], step['enter'] === true, signal)
  if (kind === 'choose' && target && str(step, 'option') && choose) return choose(target, str(step, 'option'), signal)
  if (kind === 'press' && target && press) return press(target, signal)
  if (kind === 'hover' && target && courier.hover) return courier.hover(target, signal)
  if (kind === 'key' && str(step, 'key') && pressKey) return pressKey(str(step, 'key'), signal)
  if (kind === 'scroll' && str(step, 'to') && courier.scroll) return courier.scroll(str(step, 'to'), signal)
  return { ok: false, error: 'the move is incomplete: type needs target and text, choose needs target and option, press needs target, key needs key, scroll needs to' }
}

export const PAGE_EACH_VALUES_MAX = 60
const PAGE_EACH_STEPS_MAX = 8
// Each value's page is cut to this, and the whole report to the second.
const READING_CAP = 2_500
const REPORT_CAP = 60_000

const filled = (step: unknown, value: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(step as Record<string, unknown>).map(([key, field]) => [key, typeof field === 'string' ? field.split('{value}').join(value) : field]))

// The same few moves for every value of a list - every project in a menu,
// every person, every month - with the page read after each, so a job that
// needs all of them looked at one by one is one call, not dozens. The loop
// runs here, not in the brain. A value whose moves fail is noted and the rest
// go on; anything that would commit or needs a person stops the whole run.
export function pageEachTool(courier: WebCourier): AgentTool | null {
  const readOpen = courier.readOpen
  if (!readOpen || !courier.press || !courier.typeText || !courier.choose || !courier.pressKey) return null
  return {
    name: 'page_each',
    description: `go through a list of values the same way on the open page: for each value make the same moves, with {value} written where the value goes, and read the page after - for a job that needs every item of a list, menu, set of dates or pages looked at one by one (each project, each person, each month) when no single view shows them all. Returns each value's reading. Args: {"values": ["..."] (at most ${PAGE_EACH_VALUES_MAX}, as the page names them), "steps": [moves as in page_steps, at most ${PAGE_EACH_STEPS_MAX}, e.g. {"do": "choose", "target": "Project", "option": "{value}"}, {"do": "press", "target": "Search"}]}`,
    argsSchema: {
      type: 'object', required: ['values', 'steps'], properties: {
        values: { type: 'array', maxItems: PAGE_EACH_VALUES_MAX, items: { type: 'string' } },
        steps: { type: 'array', maxItems: PAGE_EACH_STEPS_MAX, items: { type: 'object', properties: { do: { type: 'string', enum: ['type', 'choose', 'press', 'hover', 'key', 'scroll'] }, target: { type: 'string' }, text: { type: 'string' }, option: { type: 'string' }, enter: { type: 'boolean' }, key: { type: 'string' }, to: { type: 'string' } } } },
      },
    },
    async run(args, context) {
      const values = Array.isArray(args['values']) ? [...new Set(args['values'].filter((one): one is string => typeof one === 'string' && !!one.trim()))] : []
      const steps = Array.isArray(args['steps']) ? args['steps'].filter(step => step && typeof step === 'object' && !Array.isArray(step)) : []
      if (!values.length || values.length > PAGE_EACH_VALUES_MAX) return `that did not work: page_each needs 1 to ${PAGE_EACH_VALUES_MAX} values; nothing was done`
      if (!steps.length || steps.length > PAGE_EACH_STEPS_MAX) return `that did not work: page_each needs 1 to ${PAGE_EACH_STEPS_MAX} moves; nothing was done`
      const read: string[] = []
      const missed: string[] = []
      let stoppedAt = ''
      for (const value of values) {
        context.signal?.throwIfAborted()
        let failed = ''
        for (const step of steps) {
          const move = await makeMove(courier, filled(step, value), context.signal)
          if (move.committed) return { text: `Stopped at "${value}" after an approved action committed a change. The remaining moves and values were not run; verify the changed state before continuing.\n\n${read.join('\n\n')}`.slice(0, REPORT_CAP), committed: true }
          if (move.later || move.theirs || move.refused !== undefined) { stoppedAt = `"${value}": "${move.refused || 'a move'}" would commit something or needs the person, so it was not made and the values after it were left` ; break }
          if (!move.ok) { failed = move.error ?? 'a move did not work'; break }
        }
        if (stoppedAt) break
        if (failed) { missed.push(`${value} (${failed})`); continue }
        const page = await readOpen(context.signal)
        if (page.wall) { stoppedAt = `"${value}": the page now needs a person, so the values after it were left`; break }
        read.push(`## ${value}\n${page.text.trim().slice(0, READING_CAP) || '(the page showed nothing readable)'}`)
      }
      const head = `Went through ${read.length} of ${values.length} values.${missed.length ? ` Not read: ${missed.join('; ')}.` : ''}${stoppedAt ? ` Stopped at ${stoppedAt}.` : ''}`
      return `${head}\n\n${read.join('\n\n')}`.slice(0, REPORT_CAP)
    },
  }
}
