import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { listCards } from '../src/cards.js'
import { engineCwd } from '../src/engine/types.js'
import { MockEngine } from '../src/engine/mock.js'
import {
  loadErrandState,
  runErrand,
  saveErrandState,
  type ErrandDeps,
  type ErrandRetrievedNote,
  type ErrandState,
} from '../src/errand.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-08-17T00:00:00Z')
const GOAL = '배포 정책 정리'

let paths: VaultPaths

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('errand'), { git: false })
})

const note = (id: string, title: string, body: string): ErrandRetrievedNote => ({
  id,
  title,
  body,
  created: '2026-07-01T00:00:00Z',
})

// A retrieve that returns the same pool for every query (the errand dedupes by id).
const retrieverFrom =
  (pool: ErrandRetrievedNote[]) =>
  async (): Promise<ErrandRetrievedNote[]> =>
    pool

const depsWith = (engine: MockEngine, retrieve: ErrandDeps['retrieve']): ErrandDeps => ({
  engine,
  workdir: engineCwd(paths),
  retrieve,
})

const PLAN = '{"queries":["배포 정책","deploy policy"],"note_title":"배포 정책 정리"}'

describe('runErrand — happy path', () => {
  it('plans, gathers, distills, composes, and lands a new-note proposal card', async () => {
    const pool = [
      note('n-a', '배포 회의', '스테이징 먼저 배포 후 카나리로 승격한다.'),
      note('n-b', 'deploy policy', 'Rollback within 5 minutes if error rate spikes.'),
    ]
    const distill = JSON.stringify({
      points: [
        { text: '스테이징 먼저, 그다음 카나리 승격', source_ids: ['n-a'] },
        { text: 'Rollback within 5 minutes on error spike', source_ids: ['n-b'] },
      ],
    })
    const composed = '# 배포 정책 정리\n\n스테이징 먼저 배포 후 카나리로 승격 (n-a).\n롤백은 5분 이내 (n-b).'
    const engine = new MockEngine({
      'ERRAND-PLAN': PLAN,
      'ERRAND-DISTILL': distill,
      'ERRAND-COMPOSE': composed,
    })

    const phases: string[] = []
    const result = await runErrand(paths, depsWith(engine, retrieverFrom(pool)), GOAL, {
      now: () => NOW,
      onPhase: (s) => phases.push(s.phase),
    })

    expect(result.ok).toBe(true)
    expect(result.card).toBeDefined()
    expect(result.card!.cardType).toBe('new-note')
    expect(result.card!.proposed).toBe(composed)
    expect(result.title).toBe('배포 정책 정리')
    expect(new Set(result.sources)).toEqual(new Set(['n-a', 'n-b']))

    const proposed = await listCards(paths, 'proposed')
    expect(proposed.map((c) => c.id)).toContain(result.card!.id)
    expect(proposed[0]!.proposed).toBe(composed)

    expect(phases).toEqual(['plan', 'gather', 'distill', 'compose', 'done'])
  })
})

describe('runErrand — citation cleaning', () => {
  it('drops an invented source id while keeping the point text', async () => {
    const pool = [note('n-a', '배포 회의', '스테이징 먼저 배포한다.')]
    const distill = JSON.stringify({
      points: [
        { text: '스테이징 먼저 배포', source_ids: ['n-a', 'n-ghost'] },
        { text: '카나리 승격은 수동', source_ids: ['n-ghost'] },
      ],
    })
    const composed =
      '# 배포 정책\n\n스테이징 환경에 먼저 배포하고, 검증이 끝나면 카나리로 수동 승격한다. 문제가 없을 때만 전체 배포로 확대한다.'
    const engine = new MockEngine({
      'ERRAND-PLAN': PLAN,
      'ERRAND-DISTILL': distill,
      'ERRAND-COMPOSE': composed,
    })

    const result = await runErrand(paths, depsWith(engine, retrieverFrom(pool)), GOAL, { now: () => NOW })

    expect(result.ok).toBe(true)
    // The invented id never reaches sources...
    expect(result.sources).toEqual(['n-a'])
    expect(result.sources).not.toContain('n-ghost')
    // ...but the point whose only citation was invented still survives (body composed from it).
    expect(result.card!.proposed).toBe(composed)
  })
})

describe('runErrand — empty vault', () => {
  it('fails when nothing matched and leaves no resumable state', async () => {
    const engine = new MockEngine({
      'ERRAND-PLAN': PLAN,
      'ERRAND-DISTILL': '{"points":[]}',
      'ERRAND-COMPOSE': 'unused',
    })

    const result = await runErrand(paths, depsWith(engine, retrieverFrom([])), GOAL, { now: () => NOW })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('nothing')
    expect(result.card).toBeUndefined()

    // The failed phase was persisted...
    const raw = JSON.parse(await readFile(join(paths.cache, 'errand-state.json'), 'utf8')) as ErrandState
    expect(raw.phase).toBe('failed')
    // ...but loadErrandState returns null for a terminal (failed) run.
    expect(await loadErrandState(paths)).toBeNull()
  })
})

describe('runErrand — unusable plan', () => {
  it('fails with no usable queries and never calls retrieve', async () => {
    const engine = new MockEngine({
      'ERRAND-PLAN': '{"queries":[],"note_title":"x"}',
      'ERRAND-DISTILL': 'unused',
      'ERRAND-COMPOSE': 'unused',
    })
    let retrieveCalls = 0
    const retrieve: ErrandDeps['retrieve'] = async () => {
      retrieveCalls += 1
      return []
    }

    const result = await runErrand(paths, depsWith(engine, retrieve), GOAL, { now: () => NOW })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('no usable queries')
    expect(retrieveCalls).toBe(0)
  })
})

describe('runErrand — resume', () => {
  it('skips plan and distill when state carries their outputs', async () => {
    // Prefill a state parked at 'compose': plan, gathered, and points already done.
    const resume: ErrandState = {
      goal: GOAL,
      startedAt: NOW.toISOString(),
      phase: 'compose',
      plan: { queries: ['배포 정책', 'deploy policy'], noteTitle: '배포 정책 정리' },
      gathered: [note('n-a', '배포 회의', '스테이징 먼저 배포한다.')],
      points: [{ text: '스테이징 먼저 배포', sources: ['n-a'] }],
    }
    await saveErrandState(paths, resume)

    let planCalls = 0
    let distillCalls = 0
    let composeCalls = 0
    const composed =
      '# 배포 정책 정리\n\n스테이징 환경에 먼저 배포하고 검증을 거친 뒤 카나리로 승격한다 (n-a). 이후 전체 배포로 확대한다.'
    const engine = new MockEngine({
      'ERRAND-PLAN': () => {
        planCalls += 1
        return PLAN
      },
      'ERRAND-DISTILL': () => {
        distillCalls += 1
        return '{"points":[]}'
      },
      'ERRAND-COMPOSE': () => {
        composeCalls += 1
        return composed
      },
    })
    // A retrieve that would blow up if the gather phase re-ran.
    const retrieve: ErrandDeps['retrieve'] = async () => {
      throw new Error('gather should not run on resume')
    }

    const result = await runErrand(paths, depsWith(engine, retrieve), GOAL, { now: () => NOW, resume })

    expect(result.ok).toBe(true)
    expect(planCalls).toBe(0)
    expect(distillCalls).toBe(0)
    expect(composeCalls).toBe(1)
    expect(result.card!.proposed).toBe(composed)
    expect(result.sources).toEqual(['n-a'])
  })
})

describe('runErrand — thin compose', () => {
  it('fails when the composed body is too thin to propose', async () => {
    const pool = [note('n-a', '배포 회의', '스테이징 먼저 배포한다.')]
    const distill = JSON.stringify({ points: [{ text: '스테이징 먼저 배포', source_ids: ['n-a'] }] })
    const engine = new MockEngine({
      'ERRAND-PLAN': PLAN,
      'ERRAND-DISTILL': distill,
      'ERRAND-COMPOSE': 'ok',
    })

    const result = await runErrand(paths, depsWith(engine, retrieverFrom(pool)), GOAL, { now: () => NOW })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('too thin')
    expect(result.card).toBeUndefined()
    expect(await listCards(paths, 'proposed')).toHaveLength(0)
  })
})
