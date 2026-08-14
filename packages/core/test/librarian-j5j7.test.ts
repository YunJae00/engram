import { describe, expect, it } from 'vitest'
import { MockEngine } from '../src/engine/mock.js'
import {
  buildJ1,
  buildJ2,
  buildJ3,
  buildJ4,
  buildJ5,
  buildJ6,
  buildJ7,
  buildJ8,
  oldestStale,
} from '../src/jobs/librarian.js'
import { findMergeClusters } from '../src/jobs/cluster.js'
import { buildJ9 } from '../src/jobs/hub.js'
import { buildJ10, digestInput } from '../src/jobs/digest.js'
import { sweep, loadState } from '../src/jobs/sweep.js'
import { createNote } from '../src/notes.js'
import type { Note } from '../src/schema.js'
import { initVault } from '../src/vault.js'
import type { VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-05T00:00:00.000Z')

function makeNote(id: string, body: string, verified_until?: string): Note {
  return {
    front: {
      id,
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      verified_until,
      timeline: 'inferred',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
    },
    body,
  }
}

// The input payload is always the LAST fenced json block buildJobPrompt emits.
function payloadOf(prompt: string): Record<string, unknown> {
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)]
  const last = blocks[blocks.length - 1]
  if (!last) throw new Error('no json payload in prompt')
  return JSON.parse(last[1]!) as Record<string, unknown>
}

describe('J5 per-sweep cap (oldest verified_until first)', () => {
  it('caps at 40, choosing the oldest; undefined verified_until sorts oldest', () => {
    // n-00..n-04: never verified (undefined) → oldest of all.
    // n-05..n-44: verified further and further into the future as the index
    // grows, so the newest (largest index) should be the first dropped.
    const stale: Note[] = []
    for (let i = 0; i < 5; i++) stale.push(makeNote(`n-${String(i).padStart(2, '0')}`, `# note ${i}`))
    for (let i = 5; i < 45; i++) {
      // Strictly ascending valid timestamps (Jan 1 2026 + i days).
      const vu = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString()
      stale.push(makeNote(`n-${String(i).padStart(2, '0')}`, `# note ${i}`, vu))
    }
    // Feed them shuffled to prove the ordering is by verified_until, not input order.
    const shuffled = [...stale].reverse()

    const batch = oldestStale(shuffled, 40)
    const ids = batch.map((n) => n.front.id)

    expect(batch).toHaveLength(40)
    // The 5 never-verified notes come first, sorted by id.
    expect(ids.slice(0, 5)).toEqual(['n-00', 'n-01', 'n-02', 'n-03', 'n-04'])
    // The 5 newest-verified (n-40..n-44) are the ones dropped.
    for (const dropped of ['n-40', 'n-41', 'n-42', 'n-43', 'n-44']) expect(ids).not.toContain(dropped)
    // Defined ones that survive are in ascending verified_until order.
    expect(ids.slice(5, 10)).toEqual(['n-05', 'n-06', 'n-07', 'n-08', 'n-09'])

    // And buildJ5 actually ships exactly those 40 notes.
    const job = buildJ5({} as VaultPaths, '', batch, NOW)
    const stalePayload = payloadOf(job.prompt)['stale'] as { id: string }[]
    expect(stalePayload).toHaveLength(40)
    expect(stalePayload.map((s) => s.id)).toEqual(ids)
  })
})

describe('J7 deterministic pre-pairing', () => {
  const notes = [
    makeNote('dup-a', '# Redis 세션 캐시 설정\n\nRedis를 세션 캐시로 사용한다. TTL은 3600초로 둔다.'),
    makeNote('dup-b', '# Redis 세션 캐시 구성\n\nRedis를 세션 캐시로 쓴다. TTL은 3600초로 설정한다.'),
    makeNote('u-deploy', '# 배포 파이프라인\n\nGitHub Actions로 프로덕션에 자동 배포한다.'),
    makeNote('u-price', '# 프로 요금제 가격\n\n프로 요금제는 월 5만원, 연 결제 시 할인.'),
    makeNote('u-hiring', '# 채용 프로세스\n\n서류 검토, 코딩 인터뷰, 최종 면접 세 단계.'),
  ]

  it('two near-dupes + unrelated notes → exactly one cluster', () => {
    const clusters = findMergeClusters(notes)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.map((n) => n.front.id).sort()).toEqual(['dup-a', 'dup-b'])
  })

  it('the J7 prompt carries only the clustered notes; unrelated ones are absent', () => {
    const clusters = findMergeClusters(notes)
    const job = buildJ7({} as VaultPaths, '', clusters, NOW)
    const payloadClusters = payloadOf(job.prompt)['clusters'] as { id: string; excerpt: string }[][]
    expect(payloadClusters).toHaveLength(1)
    const ids = payloadClusters.flat().map((c) => c.id).sort()
    expect(ids).toEqual(['dup-a', 'dup-b'])
    for (const absent of ['u-deploy', 'u-price', 'u-hiring']) expect(ids).not.toContain(absent)
    // 200-char excerpt contract per note.
    expect(payloadClusters[0]![0]).toHaveProperty('excerpt')
  })
})

describe('sweep skips J7 when there are no candidate clusters', () => {
  it('no engine J7 call is made, yet last_j7 still advances', async () => {
    const paths = await initVault(await tmpVaultRoot('j7-skip'), { git: false })
    // Two unrelated current notes → no near-dupe cluster.
    await createNote(paths, { id: 'n-a-0001', body: '# 배포\n\nCI로 배포한다.', happened_at: '2026-06-01' }, NOW)
    await createNote(paths, { id: 'n-b-0001', body: '# 요금제\n\n프로 요금제 월 5만원.', happened_at: '2026-06-02' }, NOW)

    const invoked: string[] = []
    const record = (out: string) => (prompt: string) => {
      invoked.push(/^JOB: (\S+)/m.exec(prompt)?.[1] ?? '?')
      return out
    }
    const engine = new MockEngine({
      J2: record('{"links":[]}'),
      J3: record('{"cards":[]}'),
      J4: record('{"cards":[]}'),
      J5: record('{"cards":[]}'),
      J6: record('{"estimates":[]}'),
      J7: record('{"cards":[]}'),
      J8: record('# Brief\n\n.'),
      J10: record('# Weekly digest\n\n## What accumulated\n\n- notes.'),
    })

    await sweep(paths, [engine], { now: () => NOW })

    expect(invoked).not.toContain('J7')
    // Weekly cadence is still respected even though J7 was skipped.
    expect(typeof (await loadState(paths)).last_j7).toBe('string')
  }, 30_000)
})

describe('every librarian job runs tool-free', () => {
  it('buildJ1..J8 set disallowTools:true', () => {
    const p = {} as VaultPaths
    const note = makeNote('n-1', '# t\n\nbody')
    const corpus = [makeNote('n-2', '# other\n\nx')]
    const summary = { date: '2026-07-05', executed: 1 }
    const jobs = [
      buildJ1(p, '', 'f.md', 'content', NOW),
      buildJ2(p, '', note, corpus, NOW),
      buildJ3(p, '', [note], corpus, NOW),
      buildJ4(p, '', [note], corpus, NOW),
      buildJ5(p, '', [note], NOW),
      buildJ6(p, '', [note], NOW),
      buildJ7(p, '', [[note, corpus[0]!]], NOW),
      buildJ8(p, '', summary, NOW),
      buildJ9(p, '', [note, corpus[0]!], null, NOW),
      buildJ10(p, '', digestInput([note], NOW), NOW),
    ]
    for (const job of jobs) expect(job.disallowTools, job.kind).toBe(true)
  })

  it('judgment jobs (J3/J4/J7/J8) pin the smart model; mechanical jobs inherit the run hint', () => {
    const p = {} as VaultPaths
    const note = makeNote('n-1', '# t\n\nbody')
    const corpus = [makeNote('n-2', '# other\n\nx')]
    expect(buildJ3(p, '', [note], corpus, NOW).modelHint).toBe('default')
    expect(buildJ4(p, '', [note], corpus, NOW).modelHint).toBe('default')
    expect(buildJ7(p, '', [[note, corpus[0]!]], NOW).modelHint).toBe('default')
    expect(buildJ8(p, '', { date: '2026-07-05', executed: 1 }, NOW).modelHint).toBe('default')
    expect(buildJ9(p, '', [note, corpus[0]!], null, NOW).modelHint).toBe('default')
    expect(buildJ10(p, '', digestInput([note], NOW), NOW).modelHint).toBe('default')
    expect(buildJ1(p, '', 'f.md', 'content', NOW).modelHint).toBeUndefined()
    expect(buildJ5(p, '', [note], NOW).modelHint).toBeUndefined()
  })
})

describe('degenerate supersede/merge proposals are rejected', () => {
  it('a pointer-style proposed body creates NO card; a real body still does', async () => {
    const paths = await initVault(await tmpVaultRoot('librarian-guard'), { git: false })
    await createNote(paths, { id: 'n-old-000001', body: '# Old procedure\n\nDeploy by hand.' }, NOW)

    const spec = buildJ4(paths, '', [makeNote('n-new', '# New\n\nAutomated.')], [], NOW)
    const degenerate = await spec.apply(
      JSON.stringify({ cards: [{ cardType: 'supersede', targets: ['n-old-000001'], rationale: 'r', proposed: '[n-new로 대체]' }] }),
    )
    expect(degenerate.join('\n')).toContain('too thin')
    expect(degenerate.join('\n')).not.toContain('card raised')

    const real = await spec.apply(
      JSON.stringify({
        cards: [
          {
            cardType: 'supersede',
            targets: ['n-old-000001'],
            rationale: 'r',
            proposed: '# Deploy procedure v2\n\nFully automated to production via CI since July.',
          },
        ],
      }),
    )
    expect(real.join('\n')).toContain('card raised')
  })
})
