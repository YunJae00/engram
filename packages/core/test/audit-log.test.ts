import { describe, expect, it } from 'vitest'
import { appendAudit, auditDays, readAudit } from '../src/audit-log.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

describe('the audit log', () => {
  it('keeps one line per event, one file per day, inside the vault', async () => {
    const paths = await initVault(await tmpVaultRoot('audit'), { git: false })
    await appendAudit(paths, { at: '2026-09-03T01:00:00.000Z', kind: 'step', channel: 'bot-a', bot: 'reader', tool: 'press', detail: 'Next' })
    await appendAudit(paths, { at: '2026-09-03T01:00:05.000Z', kind: 'look', channel: 'bot-a', url: 'https://example.com/', detail: '2 fields masked' })
    await appendAudit(paths, { at: '2026-09-04T09:00:00.000Z', kind: 'approval', channel: 'bot-b', detail: 'Submit on example.com: approve' })
    const day = await readAudit(paths, '2026-09-03')
    expect(day.map((e) => e.kind)).toEqual(['step', 'look'])
    expect(day[0]!.tool).toBe('press')
    expect(day[1]!.url).toBe('https://example.com/')
    expect(await auditDays(paths)).toEqual(['2026-09-04', '2026-09-03'])
    expect(await readAudit(paths, '2026-01-01')).toEqual([])
  })

  it('caps a detail so a page dump never becomes the log', async () => {
    const paths = await initVault(await tmpVaultRoot('audit-cap'), { git: false })
    await appendAudit(paths, { at: '2026-09-03T01:00:00.000Z', kind: 'step', channel: 'c', detail: 'x'.repeat(1000) })
    expect((await readAudit(paths, '2026-09-03'))[0]!.detail).toHaveLength(200)
  })
})
