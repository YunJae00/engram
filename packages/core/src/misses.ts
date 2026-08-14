import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultPaths } from './vault.js'

const MISS_FILE = 'recall-misses.jsonl'
const SCAN_TAIL = 400 // only the recent past matters
const REPEAT_THRESHOLD = 2

interface Miss {
  q: string
  at: string
}

function missKey(query: string): string {
  return [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2))].sort().join(' ')
}

export async function recordRecallMiss(paths: VaultPaths, query: string, now: Date = new Date()): Promise<void> {
  await mkdir(paths.cache, { recursive: true })
  const entry: Miss = { q: query.trim().slice(0, 200), at: now.toISOString() }
  await appendFile(join(paths.cache, MISS_FILE), JSON.stringify(entry) + '\n')
}

export interface RepeatedMiss {
  query: string // latest wording
  count: number
  last: string
}

// Gaps the user keeps reaching for: grouped by normalized key, most-missed
// first. Only groups at/over the threshold are reported.
export async function repeatedRecallMisses(paths: VaultPaths, limit = 3): Promise<RepeatedMiss[]> {
  let raw: string
  try {
    raw = await readFile(join(paths.cache, MISS_FILE), 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter(Boolean).slice(-SCAN_TAIL)
  const groups = new Map<string, RepeatedMiss>()
  for (const line of lines) {
    let miss: Miss
    try {
      miss = JSON.parse(line) as Miss
    } catch {
      continue
    }
    const key = missKey(miss.q)
    if (!key) continue
    const prior = groups.get(key)
    if (prior) {
      prior.count += 1
      if (miss.at > prior.last) {
        prior.last = miss.at
        prior.query = miss.q
      }
    } else {
      groups.set(key, { query: miss.q, count: 1, last: miss.at })
    }
  }
  return [...groups.values()]
    .filter((g) => g.count >= REPEAT_THRESHOLD)
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
    .slice(0, limit)
}
