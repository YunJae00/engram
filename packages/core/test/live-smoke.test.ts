import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src/engine/claude.js'
import { buildJ1 } from '../src/jobs/librarian.js'
import { readAgentsMd } from '../src/jobs/prompts.js'
import { JobRunner } from '../src/jobs/runner.js'
import { loadNotes } from '../src/notes.js'
import { initVault } from '../src/vault.js'
import { LIVE_TIMEOUT_MS, tmpVaultRoot } from './helpers.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Live smoke (M2 acceptance): runs ONLY when a logged-in claude CLI is
// detected; otherwise it must be skipped, never failed.
const adapter = new ClaudeAdapter(240_000)
const detection = await adapter.detect().catch(() => ({ installed: false, loggedIn: false }))
const available = detection.installed && detection.loggedIn

describe('live smoke: claude CLI', () => {
  it.skipIf(!available)(
    'one real capture becomes a schema-valid note',
    async (ctx) => {
      const paths = await initVault(await tmpVaultRoot('live'), { git: false })
      const content = '2026년 7월 2일 팀 회의: 다음 배포는 금요일로 확정. 담당은 지민.'
      await writeFile(join(paths.inbox, 'live-memo.md'), content)
      const agentsMd = await readAgentsMd(paths)
      const runner = new JobRunner(paths, [adapter], { timeoutMs: LIVE_TIMEOUT_MS })
      const report = await runner.runAll([buildJ1(paths, agentsMd, 'live-memo.md', content, new Date())])
      if (report.haltReason || report.failed.some((f) => /authenticat|oauth|log ?in|job timeout/i.test(f.error))) {
        ctx.skip()
      }
      expect(report.failed).toEqual([])
      expect(report.executed).toBe(1)
      const notes = await loadNotes(paths) // throws if any frontmatter is invalid
      expect(notes).toHaveLength(1)
      expect(notes[0]!.body.trim().length).toBeGreaterThan(0)
    },
    600_000,
  )
})
