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

// ── Web extension ─────────────────────────────────────────────────────────

import { pickFindings, stripNoteIds, type WebCourier, type WebFinding, type WebPage } from '../src/errand.js'

const finding = (url: string, title = url): WebFinding => ({ url, title, snippet: '' })
const longText = 'Electron apps can trim memory by lazy-loading windows. '.repeat(20)

const courierOf = (results: Record<string, WebFinding[]>, pages: Record<string, WebPage>): WebCourier => ({
  search: async (query) => results[query] ?? [],
  fetchPage: async (url) => {
    const page = pages[url]
    if (!page) throw new Error('unreachable')
    return page
  },
})

describe('stripNoteIds', () => {
  it('removes bare and id-prefixed note ids, leaves ordinary parentheses', () => {
    expect(stripNoteIds('Ship it (n-lz3k9x-a1b2c3) now (id: n-abc123-zz99)')).toBe('Ship it now')
    expect(stripNoteIds('a plan (draft) with numbers (3)')).toBe('a plan (draft) with numbers (3)')
  })
})

describe('pickFindings', () => {
  it('dedupes urls and spreads across hosts before doubling up', () => {
    const picked = pickFindings(
      [finding('https://a.com/1'), finding('https://a.com/1'), finding('https://a.com/2'), finding('https://b.com/1')],
      3,
    )
    expect(picked.map((f) => f.url)).toEqual(['https://a.com/1', 'https://b.com/1', 'https://a.com/2'])
  })

  it('drops unparseable urls', () => {
    expect(pickFindings([finding('not a url'), finding('https://a.com/1')], 3)).toHaveLength(1)
  })
})

describe('runErrand — web courier', () => {
  const WEB_PLAN = '{"queries":["deploy policy","배포 정책"],"note_title":"조사 결과"}'

  it('walks the web phase, distills pages, appends a code-built source list', async () => {
    const courier = courierOf(
      { 'deploy policy': [finding('https://a.com/1', 'A')] },
      { 'https://a.com/1': { url: 'https://a.com/1', title: 'A', text: longText } },
    )
    const engine = new MockEngine({
      'ERRAND-PLAN': WEB_PLAN,
      'ERRAND-DISTILL': JSON.stringify({
        points: [{ text: 'lazy-load windows', source_ids: ['https://a.com/1'] }],
      }),
      'ERRAND-COMPOSE': '# 조사 결과\n\n창은 lazy-load 한다 [a.com](https://a.com/1). 메모리가 크게 줄어든다.',
    })
    const phases: string[] = []
    const result = await runErrand(
      paths,
      { ...depsWith(engine, retrieverFrom([])), courier },
      GOAL,
      { now: () => NOW, onPhase: (s) => phases.push(s.phase) },
    )
    expect(result.ok).toBe(true)
    expect(phases).toEqual(['plan', 'gather', 'web', 'distill', 'compose', 'done'])
    expect(result.pages).toEqual([{ url: 'https://a.com/1', title: 'A' }])
    expect(result.card!.proposed).toContain('## Sources')
    expect(result.card!.proposed).toContain('- [A](https://a.com/1)')
  })

  it('an empty vault no longer ends a web errand', async () => {
    const courier = courierOf(
      { 'deploy policy': [finding('https://a.com/1', 'A')] },
      { 'https://a.com/1': { url: 'https://a.com/1', title: 'A', text: longText } },
    )
    const engine = new MockEngine({
      'ERRAND-PLAN': WEB_PLAN,
      'ERRAND-DISTILL': '{"points":[{"text":"a fact from the page","source_ids":["https://a.com/1"]}]}',
      'ERRAND-COMPOSE': '# 조사 결과\n\n웹에서 찾은 사실만으로 구성된 본문. 충분히 길게 쓴 문단이다.',
    })
    const result = await runErrand(paths, { ...depsWith(engine, retrieverFrom([])), courier }, GOAL, { now: () => NOW })
    expect(result.ok).toBe(true)
    expect(result.sources).toEqual([])
  })

  it('retries the raw goal when every planned query finds nothing', async () => {
    const searched: string[] = []
    const courier: WebCourier = {
      search: async (query) => {
        searched.push(query)
        return query === GOAL ? [finding('https://a.com/1', 'A')] : []
      },
      fetchPage: async (url) => ({ url, title: 'A', text: longText }),
    }
    const engine = new MockEngine({
      'ERRAND-PLAN': WEB_PLAN,
      'ERRAND-DISTILL': '{"points":[{"text":"a fact","source_ids":["https://a.com/1"]}]}',
      'ERRAND-COMPOSE': '# 조사 결과\n\n목표 자체로 재검색해 찾아낸 사실을 정리한 본문이다. 길이도 충분하다.',
    })
    const result = await runErrand(paths, { ...depsWith(engine, retrieverFrom([])), courier }, GOAL, { now: () => NOW })
    expect(result.ok).toBe(true)
    expect(searched).toEqual(['deploy policy', '배포 정책', GOAL])
  })

  it('pauses at a wall, refetches once when resolved, records a skip otherwise', async () => {
    let fetches = 0
    const courier: WebCourier = {
      search: async () => [finding('https://a.com/1', 'A'), finding('https://b.com/1', 'B')],
      fetchPage: async (url) => {
        if (url === 'https://b.com/1') return { url, title: 'B', text: '', wall: 'captcha' as const }
        fetches += 1
        return fetches === 1 ? { url, title: 'A', text: '', wall: 'login' as const } : { url, title: 'A', text: longText }
      },
    }
    const engine = new MockEngine({
      'ERRAND-PLAN': WEB_PLAN,
      'ERRAND-DISTILL': '{"points":[{"text":"a fact","source_ids":["https://a.com/1"]}]}',
      'ERRAND-COMPOSE': '# 조사 결과\n\n로그인 벽을 사람이 치워준 뒤 읽은 페이지에서 얻은 사실을 정리한 본문이다.',
    })
    const walls: string[] = []
    const result = await runErrand(paths, { ...depsWith(engine, retrieverFrom([])), courier }, GOAL, {
      now: () => NOW,
      onWall: async (page) => {
        walls.push(`${page.wall}:${page.url}`)
        return page.wall === 'login' ? 'resolved' : 'skip'
      },
    })
    expect(result.ok).toBe(true)
    expect(walls).toEqual(['login:https://a.com/1', 'captcha:https://b.com/1'])
    expect(fetches).toBe(2)
    expect(result.skipped).toEqual([{ url: 'https://b.com/1', reason: 'captcha' }])
  })

  it('strips real note ids from the composed body and caps vault notes at six', async () => {
    const pool = Array.from({ length: 12 }, (_, i) =>
      note(`n-lz3k9${i}-abcd0${i}`, `t${i}`, '배포 정책 관련 메모'),
    )
    const courier = courierOf(
      { 'deploy policy': [finding('https://a.com/1', 'A')] },
      { 'https://a.com/1': { url: 'https://a.com/1', title: 'A', text: longText } },
    )
    const engine = new MockEngine({
      'ERRAND-PLAN': WEB_PLAN,
      'ERRAND-DISTILL': `{"points":[{"text":"a fact","source_ids":["${pool[0]!.id}"]}]}`,
      'ERRAND-COMPOSE': `# 조사 결과\n\n배포는 화요일에 한다 (${pool[0]!.id}). 이 결정은 지난 회의에서 확정되었다.`,
    })
    const result = await runErrand(paths, { ...depsWith(engine, retrieverFrom(pool)), courier }, GOAL, {
      now: () => NOW,
    })
    expect(result.ok).toBe(true)
    expect(result.card!.proposed).toContain('배포는 화요일에 한다. 이 결정은')
    const state = JSON.parse(await readFile(join(paths.cache, 'errand-state.json'), 'utf8')) as ErrandState
    expect(state.gathered).toHaveLength(6)
  })
})
