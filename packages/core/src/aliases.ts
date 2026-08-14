import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultPaths } from './vault.js'

export function aliasesPath(paths: VaultPaths): string {
  return join(paths.workspace, 'aliases.md')
}

const HEADER = [
  '# Aliases',
  '',
  'Names that mean the same thing — one group per line, separated by `=`.',
  'Search and the librarian treat every name on a line as the same subject.',
  'Delete a line and that equivalence is gone. The librarian may rewrite this',
  'file, so notes outside the list lines (`- `) will not survive.',
  '',
].join('\n')

const UMBRELLA_HEADING = '## Umbrella terms'

// Only `- ` list lines carry groups; anything else is prose. A term shorter
// than 2 chars would expand almost every query, so it is dropped.
// Lines under the umbrella heading are a different list and never aliases.
export function parseAliasGroups(text: string): string[][] {
  const groups: string[][] = []
  let inUmbrella = false
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) inUmbrella = line.trim() === UMBRELLA_HEADING
    if (inUmbrella || !line.startsWith('- ')) continue
    const terms = dedupeTerms(line.slice(2).split('='))
    if (terms.length >= 2) groups.push(terms)
  }
  return groups
}

// One term per line under the umbrella heading, lowercased for comparison.
export function parseUmbrellaTerms(text: string): string[] {
  const terms: string[] = []
  let inUmbrella = false
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      inUmbrella = line.trim() === UMBRELLA_HEADING
      continue
    }
    if (!inUmbrella || !line.startsWith('- ')) continue
    const term = line.slice(2).trim().toLowerCase()
    if (term.length >= 2) terms.push(term)
  }
  return terms
}

export async function loadUmbrellaTerms(paths: VaultPaths): Promise<string[]> {
  try {
    return parseUmbrellaTerms(await readFile(aliasesPath(paths), 'utf8'))
  } catch {
    return []
  }
}

function dedupeTerms(raw: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const term of raw.map((t) => t.trim()).filter((t) => t.length >= 2)) {
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
  }
  return out
}

export async function loadAliasGroups(paths: VaultPaths): Promise<string[][]> {
  try {
    return parseAliasGroups(await readFile(aliasesPath(paths), 'utf8'))
  } catch {
    return []
  }
}

async function saveAliasGroups(paths: VaultPaths, groups: string[][]): Promise<void> {
  const lines = groups.map((g) => `- ${g.join(' = ')}`)
  await writeFile(aliasesPath(paths), `${HEADER}\n${lines.join('\n')}\n`)
}

// Add one equivalence. Any existing group sharing a term is folded in
// (aliasing is transitive: teaching a=b then b=c must yield one a=b=c group).
// Returns the final merged group, or null when the input carries fewer than
// two usable terms.
export async function addAliasGroup(paths: VaultPaths, terms: string[]): Promise<string[] | null> {
  const fresh = dedupeTerms(terms)
  if (fresh.length < 2) return null
  const groups = await loadAliasGroups(paths)
  const freshKeys = new Set(fresh.map((t) => t.toLowerCase()))
  const merged: string[] = []
  const rest: string[][] = []
  for (const group of groups) {
    if (group.some((t) => freshKeys.has(t.toLowerCase()))) merged.push(...group)
    else rest.push(group)
  }
  const finalGroup = dedupeTerms([...merged, ...fresh])
  await saveAliasGroups(paths, [...rest, finalGroup])
  return finalGroup
}

// Already-known check for the librarian: a proposed pair whose terms all sit
// inside one existing group teaches nothing new.
export function coveredByAliases(terms: string[], groups: string[][]): boolean {
  const keys = dedupeTerms(terms).map((t) => t.toLowerCase())
  if (keys.length < 2) return true
  return groups.some((group) => {
    const have = new Set(group.map((t) => t.toLowerCase()))
    return keys.every((k) => have.has(k))
  })
}

const CJK_RE = /[぀-ヿ㄰-㆏一-鿿가-힯]/

// Does the query mention this term? CJK terms match by plain substring
// (no word boundaries exist); latin/digit terms require non-word neighbours
// so "ai" never fires inside "maintain".
function queryMentions(queryLower: string, term: string): boolean {
  const t = term.toLowerCase()
  if (CJK_RE.test(t)) return queryLower.includes(t)
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(queryLower)
}

// Recall-only expansion: when the query names a term of a group, the group's
// OTHER terms are appended. MiniSearch ORs terms, so this can surface notes
// filed under the other name but never hides anything.
export function expandQueryWithAliases(query: string, groups: string[][]): string {
  if (groups.length === 0) return query
  const queryLower = query.toLowerCase()
  const extras: string[] = []
  for (const group of groups) {
    if (!group.some((term) => queryMentions(queryLower, term))) continue
    for (const term of group) {
      if (!queryMentions(queryLower, term) && !extras.some((e) => e.toLowerCase() === term.toLowerCase())) {
        extras.push(term)
      }
    }
  }
  return extras.length > 0 ? `${query} ${extras.join(' ')}` : query
}
