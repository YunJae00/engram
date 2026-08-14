import { describe, expect, it } from 'vitest'
import type { Engine, EngineEvent, EngineJobInput } from '../src/engine/types.js'
import { engineCwd } from '../src/engine/types.js'
import { expandQueries, unionHits, MAX_EXPANDED_QUERIES } from '../src/retrieval.js'
import type { SearchHit } from '../src/search.js'

function stubEngine(reply: string | Error): Engine {
  return {
    id: 'mock',
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run(job: EngineJobInput): AsyncIterable<EngineEvent> {
      expect(job.modelHint).toBe('fast') // expansion must ride the cheap tier
      expect(job.disallowTools).toBe(true)
      if (reply instanceof Error) yield { type: 'error', message: reply.message }
      else yield { type: 'result', text: reply }
    },
  }
}

const CWD = engineCwd({ workspace: '/tmp/ws', privateDir: '/tmp/private' })

describe('expandQueries', () => {
  it('parses, trims, dedupes and caps the engine variants', async () => {
    const reply = JSON.stringify({
      queries: ['청킹 전략', ' chunking 512 ', '청킹 전략', '문단 분할', 'RAG 검색', '임베딩', '여섯번째'],
    })
    const queries = await expandQueries(stubEngine(reply), CWD, '문서 분할 어떻게 하기로 했지?')
    expect(queries).toHaveLength(MAX_EXPANDED_QUERIES)
    expect(queries).toContain('chunking 512')
    expect(new Set(queries).size).toBe(queries.length)
  })

  it('returns [] on engine failure or garbage output (silent fallback)', async () => {
    expect(await expandQueries(stubEngine(new Error('boom')), CWD, 'q')).toEqual([])
    expect(await expandQueries(stubEngine('마크다운 산문이며 JSON 아님'), CWD, 'q')).toEqual([])
    expect(await expandQueries(stubEngine('{"queries": "문자열이면 무시"}'), CWD, 'q')).toEqual([])
  })
})

describe('unionHits', () => {
  const hit = (id: string, score: number): SearchHit => ({ id, title: id, status: 'current', score })

  it('keeps primary order first, appends expansion by score, dedupes, caps', () => {
    const primary = [hit('a', 1), hit('b', 9)]
    const expanded = [
      [hit('b', 20), hit('c', 3)],
      [hit('d', 7), hit('e', 5)],
    ]
    const out = unionHits(primary, expanded, 4)
    expect(out.map((h) => h.id)).toEqual(['a', 'b', 'd', 'e'])
  })

  it('empty expansion returns the primary hits unchanged', () => {
    const primary = [hit('a', 1)]
    expect(unionHits(primary, [], 8)).toEqual(primary)
  })
})
