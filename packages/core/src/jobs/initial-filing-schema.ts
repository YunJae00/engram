import type { JobKind } from './prompts.js'

const text = { type: 'string' }
const list = (items: unknown) => ({ type: 'array', items })
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const cards = (kind: string) => object({ cards: list(object({ cardType: { type: 'string', enum: [kind] }, targets: list(text), rationale: text, proposed: text })) })

// Runtime-constrained output prevents a malformed answer from blocking first setup.
export const INITIAL_FILING_SCHEMAS: Partial<Record<JobKind, unknown>> = {
  J2: object({ links: list(object({ id: text, reason: text })) }),
  J3: cards('conflict'),
  J4: cards('supersede'),
  J6: object({ estimates: list(object({ id: text, happened_at: text })) }),
}
