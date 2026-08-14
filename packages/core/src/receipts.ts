import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { VaultPaths } from './vault.js'

export const JSONL_TRIM_BYTES = 256 * 1024

export async function trimJsonlIfHuge(file: string, maxBytes: number = JSONL_TRIM_BYTES): Promise<void> {
  try {
    const info = await stat(file)
    if (info.size <= maxBytes) return
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    const kept = lines.slice(Math.floor(lines.length * 0.4))
    const temp = `${file}.trim`
    await writeFile(temp, `${kept.join('\n')}\n`)
    await rename(temp, file)
  } catch {
    /* trimming is hygiene, never worth an error */
  }
}

export type RecallSurface = 'chat' | 'mcp-search' | 'mcp-context' | 'mcp-trace'

export interface RecallReceipt {
  at: string
  surface: RecallSurface
  ids: string[]
}

const LEDGER = 'recall-receipts.jsonl'

export async function recordRecallReceipt(
  paths: VaultPaths,
  surface: RecallSurface,
  ids: string[],
  now: Date = new Date(),
): Promise<void> {
  if (ids.length === 0) return
  const file = join(paths.cache, LEDGER)
  const line = `${JSON.stringify({ at: now.toISOString(), surface, ids } satisfies RecallReceipt)}\n`
  await mkdir(dirname(file), { recursive: true }).catch(() => undefined)
  await appendFile(file, line).catch(() => undefined)
  await trimJsonlIfHuge(file)
}

export async function countRecallReceipts(
  paths: VaultPaths,
  sinceMs: number,
): Promise<{ total: number; topIds: [string, number][] }> {
  let raw = ''
  try {
    raw = await readFile(join(paths.cache, LEDGER), 'utf8')
  } catch {
    return { total: 0, topIds: [] }
  }
  let total = 0
  const perId = new Map<string, number>()
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const receipt = JSON.parse(line) as RecallReceipt
      if (Date.parse(receipt.at) < sinceMs) continue
      total += 1
      for (const id of receipt.ids) perId.set(id, (perId.get(id) ?? 0) + 1)
    } catch {
      /* torn line — skip */
    }
  }
  const topIds = [...perId.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  return { total, topIds }
}
