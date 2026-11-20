import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createTask, listTasks, updateTask, type AgentTool, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-c17a-${tag}-`)), '.engram') } as unknown as VaultPaths }
const TOWNS = ['목포', '여수', '통영']
const PAGE = (town: string): string => `https://cablecar.example/${encodeURIComponent(town)}`
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const SAID = (town: string): string => `${town} 케이블카는 대인 왕복 2만 3천 원이에요. [${town} 케이블카](${PAGE(town)}/1)`
type Back = { members: { role: string; state: string; accepted?: boolean; result: string; sources?: string[] }[]; note: string }
const results = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')

async function lane(tag: string, opts: { searchMs: number; modelMs: number }) {
  const paths = await vault(tag), ask = '목포 여수 통영 케이블카 요금 비교해줘'
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const since = Date.now(), searches: { town: string; at: number; query: string }[] = [], quick: string[] = [], models: string[] = []
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
    const q = String(args['query']), town = TOWNS.find(one => q.includes(one)) ?? '목포', n = searches.length
    searches.push({ town, at: Date.now() - since, query: q }); await tick(opts.searchMs)
    return results(q, [`- ${town} 케이블카 소식 ${n} — https://news.example/${n} — ${town} 관광 이야기 — 11월 2일`, `- ${town} 케이블카 요금 안내 ${n} — ${PAGE(town)}/${n} — 대인 왕복 2만 3천 원 — 11월 20일`])
  } }
  const run: Run = async (deps, prompt, options = {}) => {
    options.onStart?.(); models.push(prompt.slice(0, 20))
    const part = prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '', town = TOWNS.find(name => part.includes(name)) ?? '목포'
    const tool = deps.tools?.find(t => t.name === 'search_web')
    if (tool) await tool.run({ query: `${town} 케이블카 요금` }, { task: prompt, ...(options.signal ? { signal: options.signal } : {}) })
    await tick(opts.modelMs)
    if (options.signal?.aborted) throw new Error('aborted')
    return { answer: SAID(town), steps: [], fellBack: false }
  }
  const engine = { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return '' } } as unknown as TurnKit['engine']
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search] }
  const hire = team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!
  return { paths, hire, since, searches, quick, models }
}
const members = TOWNS.map(town => ({ role: `${town} 조사`, topic: town, brief: `${town} 케이블카 대인 왕복 요금`, lookup: true }))

describe('c17a (B): one due for helpers on the merge path', () => {
  it('3-part split: each helper searches once, the lead gets every helper\'s own sentence and pages before 35 s, and nothing is written for it', async () => {
    const { hire, paths, since, searches, quick, models } = await lane('due', { searchMs: 1500, modelMs: 5000 })
    const text = await hire.run({ members }, { task: '' })
    const took = Date.now() - since, last = Math.max(...searches.map(s => s.at))
    expect(took).toBeLessThan(35_000)
    expect(searches).toHaveLength(3)
    expect(last).toBeLessThan(2_000)
    expect(quick).toHaveLength(0)
    expect(models).toHaveLength(3)
    const back = JSON.parse(text) as Back
    expect(back.members.map(m => [m.role, m.state, m.accepted, m.result])).toEqual(TOWNS.map(town => [`${town} 조사`, 'released', true, SAID(town)]))
    for (const [i, town] of TOWNS.entries()) expect(back.members[i]!.sources).toEqual([`https://search.example/?q=${encodeURIComponent(`${town} 케이블카 요금`)}`])
    expect(back.note).toContain('the address copied exactly from sources')
    expect(hire.closes).toBeUndefined()
    expect(hire.closesOn).toBeUndefined()
    for (const m of (await listTasks(paths))[0]!.team!.members.filter(one => one.lookup)) { expect('proof' in m).toBe(false); expect(m.data).toBeUndefined() }
  }, 45_000)

  it('the pages a helper was shown reach its member; one search each is enough', async () => {
    const { hire, paths, searches } = await lane('proof', { searchMs: 20, modelMs: 20 })
    await hire.run({ members }, { task: '' })
    const team = (await listTasks(paths))[0]!.team!.members.filter(m => m.lookup)
    expect(searches).toHaveLength(3)
    for (const m of team) {
      expect(m.shown!.some(url => url.startsWith(`${PAGE(m.topic!)}/`))).toBe(true)
      expect('proof' in m || 'missing' in m).toBe(false)
    }
  })
})
