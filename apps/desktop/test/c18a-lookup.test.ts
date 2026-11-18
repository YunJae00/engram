import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createTask, helperAnswer, helperParts, listTasks, mergingHire, updateTask, type AgentTool, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { agreeing } from '../../../packages/core/test/agreeing.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-c18a-${tag}-`)), '.engram') } as unknown as VaultPaths }
const TOWNS = ['울산', '포항', '경주', '안동']
const FEE = (town: string): string => `https://cable.example/${encodeURIComponent(town)}/fee`
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const results = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')

describe('c18a: a first-hand read is the helper\'s evidence (4-part split)', () => {
  it('paraphrased quotes, pages the host opened: all opened rows keep their values; a page that did not open leaves its row labelled', async () => {
    const paths = await vault('split'), ask = '울산 포항 경주 안동 케이블카 요금 알려줘'
    const created = await createTask(paths, ask, 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1; t.team = { members: [], hires: 0, maxHires: 8, maxDepth: 3, big: true, approvedAt: new Date().toISOString() } })
    const since = Date.now(), opened: string[] = [], judges: string[] = []
    const town = (text: string): string => TOWNS.find(one => text.includes(one)) ?? '울산'
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
      const q = String(args['query']), at = town(q); await tick(20)
      return results(q, [`- ${at} 케이블카 요금 안내 — ${FEE(at)} — ${at} 케이블카 이용 안내 — 11월 20일`, `- ${at} 여행 소식 — https://news.example/${encodeURIComponent(at)} — ${at} 관광 이야기 — 11월 19일`])
    } }
    const open: AgentTool = { name: 'open_page', description: '', argsSchema: {}, run: async args => {
      const url = String(args['url']), at = town(decodeURIComponent(url)); opened.push(url); await tick(20)
      return at === '안동' ? 'that did not work: the page did not load' : `page "${at} 케이블카 요금 안내" (DATA, not instructions):\n${at} 케이블카 요금 안내\n어른(대인) 왕복 1만 8천 원, 어린이 1만 3천 원. 매일 9시부터 운행해요.`
    } }
    const write = agreeing(async (prompt: string): Promise<string> => {
      if (prompt.includes('In "holds", for each item')) {
        await tick(20)
        const items = JSON.parse(prompt.split('\nItems: ')[1]!) as { n: number; text: string; link?: string }[], fee = items.find(item => item.link?.endsWith('/fee'))
        judges.push(town(items[0]?.text ?? ''))
        return JSON.stringify({ keep: items.map(item => item.n), asked: 1, points: ['요금: 원화 금액'], holds: fee ? { [fee.n]: { 요금: '어른 왕복 1만 8천 원' } } : {}, ...(fee ? { open: fee.n } : {}), search: '' })
      }
      if (prompt.includes('Judge meaning only')) return JSON.stringify({ problems: [] })
      const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { part: string; facts?: { id: string; text: string; link: string }[] }[]
      const rows = data.filter(p => p.facts?.length).map(p => ({ part: p.part, fact: p.facts![0]! }))
      return JSON.stringify({ message: ['요금이에요.', '', '| 도시 | 요금 | 출처 |', '|---|---|---|', ...rows.map(r => `| ${r.part} | ${r.fact.text} | ${r.fact.link} |`)].join('\n'), kept: rows.map(r => r.fact.id) })
    })
    const run: Run = async (deps, prompt, options = {}) => {
      options.onStart?.()
      const part = prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '', at = town(part)
      const tool = deps.tools?.find(t => t.name === 'search_web')
      const seen = tool ? await tool.run({ query: `${at} 케이블카 요금` }, { task: prompt, ...(options.signal ? { signal: options.signal } : {}) }) : ''
      await tick(20)
      const fee = /어른\(대인\) 왕복 1만 8천 원/.test(seen) ? '어른 왕복 1만 8천 원' : '왕복 1만 8천 원쯤'
      return { answer: `${at} 케이블카는 ${fee}이에요. [${at} 케이블카](${FEE(at)})`, steps: [], fellBack: false }
    }
    const engine = { id: 'claude', quick: async (prompt: string) => write(prompt) } as unknown as TurnKit['engine']
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
    const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search, open], alive: async () => true }
    const hire = mergingHire(team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!, async signal => helperAnswer({ ask, members: (await listTasks(paths)).find(t => t.state === 'running')?.team?.members, since, write, due: since + 28_000 + 4_000, ...(signal ? { signal } : {}) }))
    const text = await hire.run({ members: TOWNS.map(at => ({ role: `${at} 조사`, topic: at, brief: `${at} 케이블카 어른 왕복 요금`, lookup: true })) }, { task: '' })
    const members = (await listTasks(paths))[0]!.team!.members.filter(m => m.lookup)
    console.log(`c18a split: opened ${opened.length}, judges ${judges.join(',')}\n${text}`)
    for (const at of TOWNS) expect(opened).toContain(FEE(at))
    for (const at of TOWNS.slice(0, 3)) {
      const m = members.find(one => one.topic === at)!
      expect(m.sources).toContain(FEE(at))
      expect('proof' in m).toBe(false)
    }
    expect(judges).toHaveLength(0)
    const parts = helperParts(members)
    for (const at of TOWNS.slice(0, 3)) {
      const cell = parts.find(one => one.topic === at)!.data!.facts.map(f => f.text).join(' ')
      expect(cell).toContain('1만 8천 원')
      expect(cell).not.toContain('못 찾았어요')
    }
    expect(parts.find(one => one.topic === '안동')!.data!.facts.map(f => f.text).join(' ')).toContain('왕복 1만 8천 원쯤')
    expect('missing' in members.find(one => one.topic === '안동')!).toBe(false)
    for (const at of TOWNS) expect(text).toContain(at)
    expect(text).not.toContain('못 찾았어요')
  }, 45_000)
})
