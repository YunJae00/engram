import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { trimJsonlIfHuge } from '../src/receipts.js'

describe('trimJsonlIfHuge', () => {
  it('a small ledger is left byte-identical', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'engram-trim-')), 'a.jsonl')
    await writeFile(file, '{"n":1}\n{"n":2}\n')
    await trimJsonlIfHuge(file, 1024)
    expect(await readFile(file, 'utf8')).toBe('{"n":1}\n{"n":2}\n')
  })

  it('past the cap the newest lines survive, the oldest go', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'engram-trim-')), 'b.jsonl')
    const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ n: i }))
    await writeFile(file, `${lines.join('\n')}\n`)
    await trimJsonlIfHuge(file, 2048)
    const kept = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    expect(kept.length).toBeLessThan(1000)
    expect(JSON.parse(kept.at(-1)!)).toEqual({ n: 999 })
    expect(JSON.parse(kept[0]!).n).toBeGreaterThan(0)
  })
})
