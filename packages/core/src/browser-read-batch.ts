import type { AgentTool } from './agent-loop.js'
import type { WebCourier } from './errand.js'
import type { HarnessMetric } from './harness-metrics.js'
import { pageReport } from './page-report.js'
import { checkPage } from './work-evidence.js'

// Known destinations only: no clicks, field input, inferred links or automatic retries.
export function browserReadBatch(courier: WebCourier, wallMet?: (url: string) => void, emit?: (metric: HarnessMetric) => void): AgentTool {
  return {
    name: 'read_pages',
    description: 'Read 1–4 known HTTP(S) addresses within this request in order, using fresh observations. Each needs literal ready text and may specify find. Stops at the first mismatch, login, dialog or error; never submits or replays input. This navigates the current tab. Use single-page tools for unknown destinations. Results are extracts, not proof of complete records.',
    argsSchema: { type: 'object', properties: { pages: { type: 'array', minItems: 1, maxItems: 4, items: {
      type: 'object', properties: { url: { type: 'string' }, ready: { type: 'string' }, find: { type: 'string' } }, required: ['url', 'ready'], additionalProperties: false,
    } } }, required: ['pages'], additionalProperties: false },
    async run(args, context) {
      const pages = args['pages']
      if (Object.keys(args).some(key => key !== 'pages')) throw new Error('Only page reads are supported')
      if (!Array.isArray(pages) || pages.length < 1 || pages.length > 4) throw new Error('read_pages requires 1–4 pages')
      const requests = pages.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid page request')
        if (Object.keys(value).some(key => !['url', 'ready', 'find'].includes(key))) throw new Error('Only URL, ready and find are supported')
        const { url, ready, find } = value as Record<string, unknown>
        if (typeof url !== 'string' || url.length > 4096 || typeof ready !== 'string' || !ready.trim() || ready.length > 200
          || (find !== undefined && (typeof find !== 'string' || find.length > 80))) throw new Error('Each page needs a URL and short literal ready text')
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Only HTTP(S) URLs without embedded credentials are allowed')
        return { url: parsed.href, ready, find: typeof find === 'string' ? find : '' }
      })
      const reports: string[] = []
      let completed = 0
      try {
        for (const request of requests) {
          context.signal?.throwIfAborted()
          const page = await courier.fetchPage(request.url, context.signal)
          context.signal?.throwIfAborted()
          reports.push(`Source: ${page.url}\n${pageReport(page, 1, request.find)}`)
          if (page.wall) wallMet?.(page.url)
          if (page.dialog || page.faults?.length || checkPage(page, { id: `page-${completed + 1}`, url: request.url, ready: request.ready }).status !== 'passed') {
            return `that did not work: Batch stopped: ${completed}/${requests.length} readiness checks passed. The current page is unexpected or needs attention. Inspect it; do not repeat completed work.\n\n${reports.join('\n\n')}`
          }
          completed++
        }
        return `Batch read: ${completed}/${requests.length} readiness checks passed. These checks establish page readiness only, not task completion.\n\n${reports.join('\n\n')}`
      } catch (error) {
        context.signal?.throwIfAborted()
        return `that did not work: Batch stopped: ${completed}/${requests.length} readiness checks passed; the next read failed. Continue only unfinished reads.\n${error instanceof Error ? error.message : String(error)}\n\n${reports.join('\n\n')}`
      } finally { emit?.({ kind: 'batch', completed, requested: requests.length }) }
    },
  }
}
