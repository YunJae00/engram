import { parseReadBatch } from './browser-read-batch.js'
import type { AgentLoopStep, AgentTool } from './agent-loop.js'

export const COLLECTION_RULE = 'For a request to collect details for multiple items, first read the list, then use collect_results to register its item labels and requested fields. Use observed detail URLs directly; batch independent known addresses with read_pages instead of reopening the list between items. Record each item with a fresh evidenceStep. Add newly discovered items; never shrink the list to hide missing results. Record unavailable items as unverified with a reason and evidenceStep; finish with partial status when any remain unverified. Never repeat the same rejected value without new evidence. A list title or total is not evidence for hidden detail fields. If controls omit a visible card, inspect with look and press_point rather than trying unrelated New/Delete buttons. Stop for a real access barrier, approval, or user interruption; report any missing items honestly. Before recording an item as unverified or finishing partial, try it once another way (reopen the item, scroll, read another region, use a different tool). Partial is for a real barrier: permission, sign-in, missing data, or the person’s own step — not for a first failed read. When the request covers several items or places (mail bodies, group chats), go through all of them in this turn without asking to continue.'

const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim()
export function collectionProgress(steps: AgentLoopStep[]) {
  const items = new Map<string, Record<string, string> | null>()
  const unverified = new Map<string, { basis: string; evidenceStep?: number }>()
  const verifiedFields = new Map<string, Record<string, string>>()
  let fields: string[] = []
  let finish: { status: string; summary: string } | undefined
  const missing = () => [...items].filter(([, value]) => !value).map(([item]) => item)
  const pending = () => missing().some(item => !unverified.has(item)) ? `Collection incomplete: ${items.size - missing().length}/${items.size} items checked. Missing: ${JSON.stringify(missing())}. Required fields: ${JSON.stringify(fields)}.` : undefined
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 300 && value.every(text => typeof text === 'string' && text.trim().length > 0 && text.length <= 240)
  const tool: AgentTool = {
    name: 'collect_results',
    description: 'Finish browser work with status complete, partial or blocked, summary and evidenceStep against the original request. For multiple items, first track coverage. Register items (distinct labels from the observed list) and fields once; later items append without clearing results. Record one item with values and evidenceStep (1-based tool result containing those exact values). Empty values need an explicit empty field in the observation. If a value cannot be verified, record item, unverified (a factual reason) and evidenceStep instead of values. This does not count as checked; supplied values alongside an unverified reason are kept only as separately confirmed fields when the cited observation contains them; the item remains unverified. A partial or blocked finish accepts unresolved items without requiring individual ledger calls; disclose them and stop. Only a complete claim needs successful evidence for every item. No arguments returns collected values and missing items. This checks coverage of the registered list, not whether the list itself is exhaustive.',
    argsSchema: { type: 'object', additionalProperties: false, properties: {
      items: { type: 'array', items: { type: 'string' } }, fields: { type: 'array', items: { type: 'string' } },
      item: { type: 'string' }, unverified: { type: 'string', maxLength: 2000 }, values: { type: 'object', additionalProperties: { type: 'string' } }, evidenceStep: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: ['complete', 'partial', 'blocked'] }, summary: { type: 'string' },
    } },
    async run(args, context) {
      context.signal?.throwIfAborted()
      if (args.status !== undefined) {
        if (!['complete', 'partial', 'blocked'].includes(String(args.status)) || typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 2000) throw new Error('Supply complete, partial or blocked and a short explanation against the original request.')
        const barrier = steps.some(step => /"error"\s*:\s*"(?:accessibility|screen_recording|input_monitoring|policy)_denied"|requires manual control|complete sign-in or security steps/i.test(step.observation))
        const status = args.status === 'blocked' && !barrier && !steps.some(step => step.observation.startsWith('that did not work:') || /\bHTTP [45]\d\d\b|"error"\s*:\s*"policy_denied"|^The page needs the person to sign in or pass a check\./i.test(step.observation) || step.tool === 'read_pages' && parseReadBatch(step.observation)?.pages.some(page => !page.ready)) ? 'partial' : String(args.status)
        if (args.status === 'complete' && missing().length) throw new Error(pending() ?? 'Unverified items remain. Finish partial and disclose them.')
        const evidence = typeof args.evidenceStep === 'number' && Number.isInteger(args.evidenceStep) ? steps[args.evidenceStep - 1] : undefined
        if (args.status === 'complete' && (!evidence || evidence.tool === 'collect_results' || !evidence.observation.trim() || evidence.observation.startsWith('that did not work:'))) throw new Error('Cite the observation that establishes the result or barrier.')
        if (status === 'partial') for (const item of missing()) if (!unverified.has(item)) unverified.set(item, { basis: 'No verified result was recorded.' })
        finish = { status, summary: args.summary.trim() + (barrier && status !== 'complete' ? /[가-힣]/.test(context.task + args.summary) ? ' 권한 또는 보안 화면에 막혔어요.' : ' Blocked by a permission or security screen.' : status !== args.status ? ' No access barrier was observed; this work remains unverified.' : '') }
      }
      if (args.items !== undefined) {
        finish = undefined
        if (!strings(args.items) || (!fields.length && !strings(args.fields))) throw new Error('Supply nonempty item labels and requested fields.')
        if (args.fields !== undefined && (!strings(args.fields) || args.fields.length > 16 || fields.length && JSON.stringify(args.fields) !== JSON.stringify(fields))) throw new Error('Keep the original requested fields.')
        if (new Set([...items.keys(), ...args.items]).size > 300) throw new Error('A collection supports at most 300 distinct items.')
        if (!fields.length) fields = args.fields as string[]
        for (const item of args.items) if (!items.has(item)) items.set(item, null)
      }
      if (args.item !== undefined) {
        finish = undefined
        if (typeof args.item !== 'string' || !items.has(args.item)) throw new Error('Register this item before recording its details.')
        const evidence = typeof args.evidenceStep === 'number' && Number.isInteger(args.evidenceStep) ? steps[args.evidenceStep - 1] : undefined
        if (args.unverified !== undefined) {
          if (typeof args.unverified !== 'string' || !args.unverified.trim() || args.unverified.length > 2000) throw new Error('Supply a factual unverified reason.')
          const linked = evidence && evidence.tool !== tool.name && evidence.observation.trim()
          const observed = linked && !evidence.observation.startsWith('that did not work:') ? (evidence.tool === 'read_pages' ? parseReadBatch(evidence.observation)?.pages.filter(page => page.ready).map(page => page.observation).join('\n') ?? '' : evidence.observation) : ''
          const mentionsItem = (text: string) => normalize(text).toLowerCase().includes(normalize(args.item as string).toLowerCase())
          const pages = linked && evidence.tool === 'read_pages' ? parseReadBatch(evidence.observation)?.pages : undefined
          const contradictory = linked && (pages && /\b403\b|forbidden|HTTP [45]\d\d/i.test(args.unverified as string)
            ? pages.some(page => page.ready && mentionsItem(page.observation)) && !pages.some(page => !page.ready && mentionsItem(page.observation))
            : !mentionsItem(evidence.observation) && [...items.keys()].some(item => item !== args.item && normalize(evidence.observation).toLowerCase().includes(normalize(item).toLowerCase())))
          const supplied = args.values && typeof args.values === 'object' && !Array.isArray(args.values) ? args.values as Record<string, unknown> : {}
          const known = Object.fromEntries(fields.flatMap(field => {
            const value = supplied[field]
            return typeof value === 'string' && value.length <= 6000 && normalize(value) && normalize(observed).includes(normalize(value)) ? [[field, value]] : []
          }))
          if (Object.keys(known).length) verifiedFields.set(args.item, { ...verifiedFields.get(args.item), ...known })
          else if (Object.keys(supplied).length) verifiedFields.delete(args.item)
          const unsupported = fields.filter(field => supplied[field] !== undefined && known[field] === undefined)
          items.set(args.item, null)
          unverified.set(args.item, { basis: args.unverified.trim() + (unsupported.length ? ` Unverified supplied fields: ${unsupported.join(', ')}.` : '') + (!linked ? ' No supporting observation was linked.' : contradictory ? " The cited observation does not establish this item's limitation." : ''), ...(linked ? { evidenceStep: args.evidenceStep as number } : {}) })
        } else {
          if (!evidence || evidence.tool === tool.name || !evidence.observation.trim() || evidence.observation.startsWith('that did not work:')) throw new Error('Cite a successful tool observation, not this ledger or an error.')
          const observed = evidence.tool === 'read_pages' ? parseReadBatch(evidence.observation)?.pages.filter(page => page.ready).map(page => page.observation).join('\n') ?? (/^Batch read:/.test(evidence.observation) ? evidence.observation : '') : evidence.observation
          const values = args.values
          if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Supply the requested field values.')
          const record = values as Record<string, unknown>
          const known = Object.fromEntries(fields.flatMap(field => {
            const value = record[field]
            return typeof value === 'string' && value.length <= 6000 && normalize(value) && normalize(observed).includes(normalize(value)) ? [[field, value]] : []
          }))
          const missingField = fields.find(field => known[field] === undefined)
          if (missingField) {
            if (JSON.stringify([...verifiedFields, [args.item, known]]).length > 128_000) throw new Error('Confirmed field excerpts exceed the checkpoint limit. Keep them concise.')
            if (Object.keys(known).length) verifiedFields.set(args.item, known)
            items.set(args.item, null)
            throw new Error(`Read and cite the actual ${missingField} value. Separately evidenced fields are retained, but this item remains unverified. Use the page's explicit empty-field marker when blank; do not guess. If unavailable, record unverified with the reason and evidenceStep, then finish partial instead of resubmitting this value.`)
          }
        const next = Object.fromEntries(fields.map(field => [field, record[field] as string]))
        if (JSON.stringify([...items].map(([item, value]) => [item, item === args.item ? next : value])).length > 128_000) throw new Error('Collected results exceed the checkpoint limit. Keep field excerpts concise and use a file for larger results.')
        items.set(args.item, next)
        unverified.delete(args.item)
        verifiedFields.delete(args.item)
        }
      }
      return JSON.stringify({ checked: items.size - missing().length, total: items.size, missing: missing(), results: Object.fromEntries(items), unverified: Object.fromEntries(unverified), verifiedFields: Object.fromEntries(verifiedFields), finish, next: finish ? (finish.status === 'complete' ? 'The completion report is recorded. Answer with the verified results; do not resubmit this report.' : 'The incomplete report is recorded. Explain the unverified items and stop; do not resubmit to turn unknown results into success.') : pending() ?? 'Check the original scope. Before answering a browser task, record status complete, partial or blocked, summary and evidenceStep. For multiple items register the full observed list and requested fields first.' })
    },
  }
  return { tool, pending, summary: () => [...items].map(([item, values]) => `${item}: ${values ? Object.entries(values).map(([field, value]) => `${field}: ${value}`).join('; ') : `Not verified — ${unverified.get(item)?.basis ?? 'No verified result was recorded.'}${verifiedFields.has(item) ? ` Confirmed fields: ${Object.entries(verifiedFields.get(item)!).map(([field, value]) => `${field}: ${value}`).join('; ')}` : ''}`}`).join('\n\n'), open: () => missing().length > 0, unverified: () => unverified.size ? `Unverified collection items (${unverified.size}/${items.size}): ${[...unverified].map(([item, detail]) => `${item}: ${detail.basis}`).join('; ')}` : undefined, checked: () => items.size - missing().length, finish: () => finish, invalidate: () => { finish = undefined } }
}
