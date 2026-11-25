import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool, Engine, ToolSessionJob } from 'core'
import { answer, openWorld } from '../src/main/answer.js'

const scratch: string[] = []
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'answer-test-')); scratch.push(dir); return dir }
afterEach(async () => { await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const wait = (ms: number) => new Promise(done => setTimeout(done, ms))
const fake = (lead: (job: ToolSessionJob) => Promise<string>, quick?: (prompt: string) => Promise<string>): Engine => ({
  id: quick ? 'claude' : 'mock',
  desktopToolIsolation: true,
  ...(quick ? { quick } : {}),
  detect: async () => ({ installed: true, loggedIn: true }),
  run: async function* () { yield { type: 'result', text: '' } },
  runTools: async (job: ToolSessionJob) => ({ answer: await lead(job) }),
}) as unknown as Engine

describe('answer is the one entry the app and the runner share', () => {
  it('hands the app\'s persona, memory, history, notes and tool list to the engine call', async () => {
    let told = '', menu: string[] = []
    const engine = fake(async job => { told = [job.system, job.opening, job.prompt].join('\n'); menu = job.tools.map(tool => tool.name); return '반납일은 금요일이에요.' })
    const shelf: AgentTool = { name: 'shelf_lookup', description: 'finds a book on the shelf', argsSchema: { type: 'object' }, run: async () => '3층 서가' }
    const world = { ...await openWorld(await temp(), engine), history: [{ role: 'user' as const, text: '지난주에 빌린 책은 "바다의 지도"야' }, { role: 'assistant' as const, text: '"바다의 지도" 기억할게요.' }] }
    const { trace, result } = await answer(world, '그 책 반납일 언제야?', { tools: [shelf], persona: 'You are 하람, the reading-room helper.', memory: 'The person reads on the 3rd floor.', context: () => 'The library closes at 9.' })
    expect(told).toContain('하람, the reading-room helper')
    expect(told).toContain('The person reads on the 3rd floor.')
    expect(told).toContain('바다의 지도')
    expect(told).toContain('The library closes at 9.')
    expect(menu).toContain('shelf_lookup')
    expect(menu).not.toContain('search_web')
    expect(result?.answer).toBe('반납일은 금요일이에요.')
    expect(trace.final.text).toBe('반납일은 금요일이에요.')
  })

  it('shows the ack as the first text when it comes before the lead\'s answer, and the lead is told it is on screen', async () => {
    let told = ''
    const shown = vi.fn()
    const engine = fake(async job => { told = job.system + job.opening + job.prompt; await wait(80); job.onToken?.('대출 기록을 보니 반납일은 금요일이에요.'); return '대출 기록을 보니 반납일은 금요일이에요.' }, async prompt => prompt.includes('first line') ? '대출 기록부터 볼게요.' : 'NONE')
    const { trace } = await answer(await openWorld(await temp(), engine), '빌린 책 반납일 언제야?', { ack: { show: shown } })
    expect(trace.first?.text).toBe('대출 기록부터 볼게요.')
    expect(shown).toHaveBeenCalledExactlyOnceWith('대출 기록부터 볼게요.')
    expect(told).toContain('A short first line from you saying what you are starting on is already on screen')
    expect(trace.final.text).toBe('대출 기록을 보니 반납일은 금요일이에요.')
  })

  it('drops an ack that comes after the answer is done', async () => {
    const shown = vi.fn()
    const engine = fake(async () => '열람실은 밤 9시까지예요.', async () => { await wait(150); return '운영 시간부터 볼게요.' })
    const { trace } = await answer(await openWorld(await temp(), engine), '열람실 몇 시까지 열어?', { ack: { show: shown } })
    await wait(250)
    expect(shown).not.toHaveBeenCalled()
    expect(trace.first?.text).toBe('열람실은 밤 9시까지예요.')
  })

  it('shows the waiting line the app shows when the quick voice is slow, and holds the lead\'s words behind it', async () => {
    const shown = vi.fn(), held: boolean[] = []
    const engine = fake(async job => { await wait(1500); job.onToken?.('신간은 세 권이에요.'); return '신간은 세 권이에요.' }, async () => { await wait(1450); return '신간 목록부터 볼게요.' })
    const { trace } = await answer(await openWorld(await temp(), engine), '이번 주 신간 몇 권이야?', { ack: { show: shown }, onToken: (_, hold) => { held.push(hold) } })
    expect(shown).toHaveBeenCalledOnce()
    expect(trace.first?.text).toBe(shown.mock.calls[0]![0])
    expect(trace.first!.ms).toBeLessThan(1450)
    expect(held).toEqual([true])
  })

  it('streams the lead\'s words as the first text when no ack is wanted', async () => {
    const engine = fake(async job => { await wait(30); job.onToken?.('반가워요, 오늘도 잘 부탁드려요.'); await wait(30); return '반가워요, 오늘도 잘 부탁드려요.' }, async () => '사서 업무부터 볼게요.')
    const held: boolean[] = []
    const { trace } = await answer(await openWorld(await temp(), engine), '사서님 안녕하세요', { ack: { interactive: false }, onToken: (_, hold) => { held.push(hold) } })
    expect(held).toEqual([false])
    expect(trace.first?.text).toBe('반가워요, 오늘도 잘 부탁드려요.')
    expect(trace.first!.ms).toBeLessThan(trace.final.ms)
  })

  it('answers from the quick voice when the app asks for a whole answer, and the lead never runs', async () => {
    const lead = vi.fn(async () => '쓰이면 안 돼요.')
    const engine = fake(lead, async prompt => prompt.includes('short question') ? '한 시간은 3,600초예요.' : 'NONE')
    const { result } = await answer(await openWorld(await temp(), engine), '한 시간은 몇 초야?', { ack: { whole: true } })
    expect(result?.answer).toBe('한 시간은 3,600초예요.')
    expect(lead).not.toHaveBeenCalled()
  })

  it('hands a failed lead step back as the failure, with the trace kept', async () => {
    const engine = fake(async () => { throw new Error('서가 정리 중') })
    const { trace, result, failure } = await answer(await openWorld(await temp(), engine), '신간 목록 보여줘')
    expect(result).toBeUndefined()
    expect(failure).toBeInstanceOf(Error)
    expect(trace.error).toBe('서가 정리 중')
  })

  it('shows the ack before slow work a round does ahead of the lead, and that round\'s own limits reach the engine', async () => {
    const shown: number[] = [], started = performance.now()
    let calls = 0
    const engine = fake(async job => { calls = job.maxCalls; return '주차장은 지하 2층이에요.' }, async () => '안내도부터 볼게요.')
    await answer(await openWorld(await temp(), engine), '주차장 어디야?', {
      ack: { show: () => { shown.push(performance.now() - started) } },
      maxCalls: 9,
      rounds: async lead => { await wait(400); return lead('주차장 어디야?', new AbortController().signal, { maxCalls: 2 }) },
    })
    expect(shown).toHaveLength(1)
    expect(shown[0]!).toBeLessThan(400)
    expect(calls).toBe(2)
  })

  it('ipc runs the lane\'s first search inside the answer\'s rounds, after the ack has started', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    const call = ipc.indexOf('await answer({ paths, botId: bot.id')
    expect(ipc.slice(0, call)).not.toMatch(/await searchFor\(/)
    expect(ipc.slice(call)).toMatch(/rounds: lead => [^]*?searched = await searchFor\(/)
  })

  it('ipc makes a bot\'s answer through answer, with no runComet call of its own', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(ipc).not.toMatch(/\brunComet\b/)
    expect(ipc).not.toMatch(/beginFirstLine|endFirstLine|firstLineReady/)
    expect(ipc).toContain('await answer({ paths, botId: bot.id, engine: team.leadEngine(channel, engine),')
  })
})
