import { collectResult, extractJson, type Engine, type EngineCwd } from './engine/types.js'
import type { SearchHit } from './search.js'

export const WEAK_HIT_COUNT = 3
// Expansion is a rescue attempt, not the answer. On a local model it runs a
// whole extra generation ahead of the real one, so it gets a short leash and
// the caller's cancel.
export const EXPANSION_BUDGET_MS = 15_000
export const MAX_EXPANDED_QUERIES = 5

export function expansionPrompt(question: string): string {
  return [
    'We are running a full-text search (BM25-style) over a personal note vault. Produce 3-5 search queries so that notes recording the same subject in DIFFERENT words are also retrieved: synonyms, technical terms in English, adjacent keywords.',
    'Do not repeat the question verbatim. Each query is a bag of 2-6 keywords.',
    'When the question is not in English, include queries in BOTH the original language and English — vaults are often mixed.',
    'Output only JSON {"queries":["..."]}.',
    `Question: ${question}`,
  ].join('\n')
}

export async function expandQueries(
  engine: Engine,
  workdir: EngineCwd,
  question: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const raw = await collectResult(engine, {
      prompt: expansionPrompt(question),
      workdir,
      disallowTools: true,
      modelHint: 'fast',
      timeoutMs: EXPANSION_BUDGET_MS,
      ...(signal ? { signal } : {}),
    })
    const parsed = extractJson(raw) as { queries?: unknown } | null
    const list = Array.isArray(parsed?.queries) ? parsed.queries : []
    const cleaned = list
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 1)
      .map((q) => q.trim())
    return [...new Set(cleaned)].slice(0, MAX_EXPANDED_QUERIES)
  } catch {
    return []
  }
}

// Primary (lexical) hits keep their order and rank first; expansion hits
// join by descending score, deduped, up to `cap` total.
export function unionHits(primary: SearchHit[], expanded: SearchHit[][], cap: number): SearchHit[] {
  const seen = new Set(primary.map((h) => h.id))
  const out = primary.slice(0, cap)
  const pool = expanded.flat().sort((a, b) => b.score - a.score)
  for (const hit of pool) {
    if (out.length >= cap) break
    if (seen.has(hit.id)) continue
    seen.add(hit.id)
    out.push(hit)
  }
  return out
}
