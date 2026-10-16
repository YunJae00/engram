import { brainConnection, connectionFetch, loadBrainConnections } from './brain-connections.js'
import { flog } from './flog.js'

// A decision model answers typed questions about a state and never writes:
// given the controls an app shows and a goal, it picks the one to act on, in
// a fraction of a second and for a fraction of a cent. It is reached at the
// endpoint the person connected under 'decision'; without one, nothing here
// is offered.
export interface ChoiceDecision { choice: string; confidence: number; probabilities: Record<string, number>; ms: number }
const TIMEOUT_MS = 20_000
const STATE_LIMIT = 60_000

export async function decisionAvailable(): Promise<boolean> {
  await loadBrainConnections()
  return !!brainConnection('decision')
}

function readChoice(body: unknown, name: string): Omit<ChoiceDecision, 'ms'> {
  const answers = (body as { answers?: Record<string, unknown> } | null)?.answers
  const answer = answers?.[name] as { choice?: unknown; confidence?: unknown; probabilities?: unknown } | undefined
  if (!answer || typeof answer.choice !== 'string') throw new Error('The decision model answered without a choice.')
  const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? Object.fromEntries(Object.entries(answer.probabilities as Record<string, unknown>).filter(([, value]) => typeof value === 'number')) as Record<string, number> : {}
  const confidence = typeof answer.confidence === 'number' ? answer.confidence : probabilities[answer.choice] ?? 0
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('The decision model returned an invalid confidence.')
  return { choice: answer.choice, confidence, probabilities }
}

// One choice question: the options with a line each on what they mean.
export async function decideChoice(state: string, instructions: string, criteria: Record<string, string>, fetchImpl: typeof fetch = connectionFetch, signal?: AbortSignal): Promise<ChoiceDecision> {
  signal?.throwIfAborted()
  await loadBrainConnections()
  const connection = brainConnection('decision')
  if (!connection) throw new Error('No decision model is connected. Add one under Settings → AI.')
  if (!connection.model) throw new Error('The decision connection needs a model ID (the decision model\'s name).')
  const options = Object.keys(criteria)
  if (options.length < 2) throw new Error('A choice needs at least two options.')
  if (options.length > 255) throw new Error('A choice takes at most 255 options.')
  const started = Date.now()
  const response = await fetchImpl(connection.baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.key}` },
    body: JSON.stringify({ state: state.slice(0, STATE_LIMIT), model: connection.model, questions: { next: { type: 'choice', instructions, criteria } } }),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) {
    flog('decision', `endpoint answered ${response.status}`)
    throw new Error(response.status === 401 || response.status === 403 ? 'The decision endpoint did not accept the key.' : response.status === 429 ? 'The decision endpoint is rate limited right now.' : `The decision endpoint answered ${response.status}.`)
  }
  let body: unknown
  try { body = JSON.parse(text) } catch { throw new Error('The decision endpoint did not answer with JSON.') }
  const decision = readChoice(body, 'next')
  if (!options.includes(decision.choice)) throw new Error(`The decision model chose "${decision.choice}", which was not offered.`)
  return { ...decision, ms: Date.now() - started }
}
