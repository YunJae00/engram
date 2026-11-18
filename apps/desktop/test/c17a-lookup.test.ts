import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createTask, helperAnswer, listTasks, mergingHire, updateTask, type AgentTool, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

// c17a on the anonymous split, as ipc wires it (hire_members → mergingHire → helperAnswer, each helper's search_web through checkedSearch):
// (B) one due for helpers: a helper is due one reserve before the writer's due (its draft + one check), not LEAD_ANSWER_MS on top of
// the merge reserve; (E) a helper's verified quotes and missing points reach its member. Wordings in no harness row: 목포/여수/통영 케이블카.
type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-c17a-${tag}-`)), '.engram') } as unknown as VaultPaths }
const TOWNS = ['목포', '여수', '통영']
const PAGE = (town: string): string => `https://cablecar.example/${encodeURIComponent(town)}`
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const tableRows = (text: string): string[] => text.split('\n').filter(line => /^\s*\|.*\|\s*$/.test(line) && !/^[\s|:-]+$/.test(line)).slice(1)
const results = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')

async function lane(tag: string, opts: { searchMs: number; judgeMs: number; modelMs: number; writeMs: number; checkMs: number; proveAt?: number }) {
  const paths = await vault(tag), ask = '목포 여수 통영 케이블카 요금 비교해줘'
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const since = Date.now(), searches: { town: string; at: number; query: string }[] = [], quick: { kind: string; at: number }[] = [], models: string[] = []
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
    const q = String(args['query']), town = TOWNS.find(one => q.includes(one)) ?? '목포', n = searches.length
    searches.push({ town, at: Date.now() - since, query: q }); await tick(opts.searchMs)
    return results(q, [`- ${town} 케이블카 소식 ${n} — https://news.example/${n} — ${town} 관광 이야기 — 11월 2일`, `- ${town} 케이블카 요금 안내 ${n} — ${PAGE(town)}/${n} — 대인 왕복 2만 3천 원 — 11월 20일`])
  } }
  const write = async (prompt: string): Promise<string> => {
    if (prompt.includes('In "holds", for each item')) {
      quick.push({ kind: 'judge', at: Date.now() - since }); await tick(opts.judgeMs)
      const round = quick.filter(q => q.kind === 'judge').length, items = JSON.parse(prompt.split('\nItems: ')[1]!) as { n: number; text: string }[]
      // The fee is stated in a row's own words; this judge only quotes it from proveAt on, so before that every helper keeps looking.
      const fee = items.find(item => item.text.includes('2만 3천 원'))
      const holds = opts.proveAt !== undefined && Date.now() - since >= opts.proveAt && fee ? { [fee.n]: { 요금: '대인 왕복 2만 3천 원' } } : {}
      return JSON.stringify({ keep: items.map(item => item.n), asked: 1, points: ['요금'], holds, search: `${items[0]!.text.split(' ')[0]} 케이블카 요금 ${round}` })
    }
    if (prompt.includes('Judge meaning only')) { quick.push({ kind: 'check', at: Date.now() - since }); await tick(opts.checkMs); return JSON.stringify({ problems: [] }) }
    quick.push({ kind: 'write', at: Date.now() - since }); await tick(opts.writeMs)
    const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { part: string; facts?: { id: string; text: string; link: string }[] }[]
    const rows = data.filter(p => p.facts?.length).map(p => ({ part: p.part, fact: p.facts![0]! }))
    return JSON.stringify({ message: ['세 곳 요금이에요.', '', '| 도시 | 요금 | 출처 |', '|---|---|---|', ...rows.map(r => `| ${r.part} | ${r.fact.text} | ${r.fact.link} |`)].join('\n'), kept: rows.map(r => r.fact.id) })
  }
  const run: Run = async (deps, prompt, options = {}) => {
    options.onStart?.(); models.push(prompt.slice(0, 20))
    const part = prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '', town = TOWNS.find(name => part.includes(name)) ?? '목포'
    const tool = deps.tools?.find(t => t.name === 'search_web')
    if (tool) await tool.run({ query: `${town} 케이블카 요금` }, { task: prompt, ...(options.signal ? { signal: options.signal } : {}) })
    await tick(opts.modelMs)
    if (options.signal?.aborted) throw new Error('aborted')
    return { answer: `${town} 케이블카는 대인 왕복 2만 3천 원이에요. [${town} 케이블카](${PAGE(town)}/1)`, steps: [], fellBack: false }
  }
  const engine = { id: 'claude', quick: async (prompt: string) => write(prompt) } as unknown as TurnKit['engine']
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search], alive: async () => true }
  // The writer's due as ipc sets it (c17a): the task's answer due plus the writer's own time.
  const hire = mergingHire(team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!, async signal => helperAnswer({ ask, members: (await listTasks(paths)).find(t => t.state === 'running')?.team?.members, since, write, due: since + 28_000 + 4_000, ...(signal ? { signal } : {}) }))
  return { paths, hire, since, searches, quick, models }
}
const members = TOWNS.map(town => ({ role: `${town} 조사`, topic: town, brief: `${town} 케이블카 대인 왕복 요금`, lookup: true }))

describe('c17a (B): one due for helpers on the merge path', () => {
  it('3-part split, no row ever quoted: helpers keep searching to their own due, the answer is still one linked table before 35 s', async () => {
    // Measured sizes (stack16 log): a search ~1.5-2.5 s, a quick judgment ~1.5-2.5 s, a helper's answer ~5 s, a writer draft ~3 s.
    const { hire, paths, since, searches, quick, models } = await lane('due', { searchMs: 1500, judgeMs: 1500, modelMs: 5000, writeMs: 3000, checkMs: 2500 })
    const text = await hire.run({ members }, { task: '' })
    const took = Date.now() - since, last = Math.max(...searches.map(s => s.at))
    console.log(`c17a fake split: delivered ${took} ms, searches ${searches.length}, last search start ${last} ms, judge ${quick.filter(q => q.kind === 'judge').length}, writer calls ${quick.filter(q => q.kind !== 'judge').map(q => `${q.kind}@${q.at}`).join(' ')}, helper model calls ${models.length}`)
    expect(took).toBeLessThan(35_000)
    // Before c17a the rounds ended by ~10 s (helper due 22 s less its answer reserve and one round); now each helper's last search may
    // start past 12 s: due 25 s (28 s less one check: the writer's draft is inside its own due), less its answer reserve and one round.
    expect(last).toBeGreaterThanOrEqual(12_000)
    expect(models).toHaveLength(3)
    const rows = tableRows(text)
    expect(rows.map(row => row.split('|')[1]!.trim())).toEqual(TOWNS)
    // c17a r2 (review #1): no row's fee was ever quoted and no helper opened a page, so the helpers' cited fee is not evidence: each row
    // says it was not found, with the page looked at, never the unproven value.
    for (const row of rows) { expect(row).toMatch(/\]\(https:\/\//); expect(row).not.toContain('2만 3천') }
    expect(hire.closesOn!(text)).toBe(true)
    // c17a r3 (review #2): judged with nothing verified is recorded as such (proof []), never left as "never judged".
    for (const m of (await listTasks(paths))[0]!.team!.members.filter(one => one.lookup)) expect(m.proof).toEqual([])
  }, 45_000)

  it('a helper\'s verified quotes reach its member; a quoted fee stops its search at once', async () => {
    const { hire, paths, searches } = await lane('proof', { searchMs: 20, judgeMs: 20, modelMs: 20, writeMs: 20, checkMs: 20, proveAt: 0 })
    await hire.run({ members }, { task: '' })
    const team = (await listTasks(paths))[0]!.team!.members.filter(m => m.lookup)
    expect(searches).toHaveLength(3)
    for (const m of team) {
      expect(m.proof?.[0]).toMatchObject({ point: '요금', quote: '대인 왕복 2만 3천 원' })
      expect(m.missing).toBeUndefined()
    }
  })
})
